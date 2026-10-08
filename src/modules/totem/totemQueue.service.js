// src/modules/totem/totemQueue.service.js
// Single owner of the queue→session→slot lifecycle.
//
// Model: one session per player, scoped to an INSTANCE of a totem. Instance
// 'default' is the physical totem (UDP); any other id is an embedded iframe
// (SSE) with its own queue and slots. An instance with maxPlayers=N holds up
// to N live sessions (reserved|active). When any session ends, advance() pops
// the next living player from that instance's Redis queue and reserves a
// fresh session for them (they have env.queueReserveMs to claim it via
// WebSocket connect).
//
// Every mutating public method serializes on a per-instance mutex
// (instanceKey(totemId, instanceId)) so concurrent requests can never
// double-book a slot or duplicate sessions.
// IMPORTANT: methods named *_Locked assume the instance lock is already held
// and must never call this._lock themselves (the keyed mutex is not re-entrant).

import { SessionRepository } from '../session/session.repository.js'
import { SessionCache }      from '../session/session.cache.js'
import {
  Channels, buildMessage, instanceKey, queueKey, queueEventChannel,
  normalizeInstance, isDefaultInstance,
} from '../../lib/channels.js'
import { createKeyedMutex }  from '../../lib/mutex.js'
import { env }               from '../../config/env.js'
import { createLogger }      from '../../lib/logger.js'

const log = createLogger('totem.queue')

const HEARTBEAT_SECS = 120

export class TotemQueueService {
  /**
   * @param {import('fastify').FastifyInstance} fastify  (mongo, redisPublisher, instances, gameOutput; gameHandler/udpDispatcher lazily at call time)
   * @param {import('./totem.service.js').TotemService} totemService
   */
  constructor(fastify, totemService) {
    this._fastify = fastify
    this._totems  = totemService
    this.repo     = new SessionRepository(fastify.mongo)
    this.cache    = new SessionCache(fastify.redisPublisher)
    this._redis   = fastify.redisPublisher ?? null
    this._mutex   = createKeyedMutex()
  }

  // ── Player-facing ────────────────────────────────────────────────────────

  /**
   * Player scans the QR / retries. Idempotent: an existing live session for
   * this player on this instance is returned as-is.
   * @returns {{ok:true,status:'play',sessionId}|{ok:true,status:'queue',position,estimatedWaitMs}|{ok:false,code,error}}
   */
  async join(totemId, instanceId, playerId, metadata = null) {
    const inst = normalizeInstance(instanceId)
    return this._lock(totemId, inst, () => this._joinLocked(totemId, inst, playerId, metadata))
  }

  async _joinLocked(totemId, instanceId, playerId, metadata) {
    const totem = await this._totems.findTotem(totemId)
    if (!totem) return { ok: false, code: 404, error: 'Totem not found' }
    const closed = await this._checkInstance(totemId, instanceId)
    if (closed) return closed

    const existing = await this.repo.findCurrentByPlayer(totemId, instanceId, playerId)
    if (existing) return { ok: true, status: 'play', sessionId: existing._id }

    const maxPlayers = totem.maxPlayers ?? env.sessionMaxPlayers
    const occupied   = await this.repo.countCurrent(totemId, instanceId)
    const queueSize  = await this._queueLen(totemId, instanceId)

    if (occupied < maxPlayers && queueSize === 0) {
      const session = await this._createReserved(totem, instanceId, playerId, metadata)
      return { ok: true, status: 'play', sessionId: session._id }
    }

    if (!this._redis) return { ok: false, code: 503, error: 'Queue unavailable (Redis offline)' }
    if (totem.maxQueueSize && queueSize >= totem.maxQueueSize) {
      return { ok: false, code: 409, error: 'Queue is full' }
    }

    const position = await this._enqueue(totemId, instanceId, playerId, metadata)
    const estimatedWaitMs = await this.estimateWait(totem, position)
    return { ok: true, status: 'queue', position, estimatedWaitMs }
  }

  /**
   * Poll from the waiting screen. Refreshes the heartbeat, self-heals by
   * advancing if slots are free, and reports 'play' once a session exists.
   */
  async status(totemId, instanceId, playerId) {
    const inst = normalizeInstance(instanceId)
    return this._lock(totemId, inst, async () => {
      const totem = await this._totems.findTotem(totemId)
      if (!totem) return { ok: false, code: 404, error: 'Totem not found' }
      const closed = await this._checkInstance(totemId, inst)
      if (closed) return closed

      let session = await this.repo.findCurrentByPlayer(totemId, inst, playerId)
      if (!session) {
        if (this._redis) await this._redis.setex(this._hbKey(playerId), HEARTBEAT_SECS, '1')
        await this._advanceLocked(totem, inst)
        session = await this.repo.findCurrentByPlayer(totemId, inst, playerId)
      }
      if (session) return { ok: true, status: 'play', sessionId: session._id }

      if (!this._redis) return { ok: false, code: 404, error: 'Not in queue' }
      const pos = await this._redis.lpos(queueKey(totemId, inst), playerId)
      if (pos === null) return { ok: false, code: 404, error: 'Not in queue' }

      const size = await this._queueLen(totemId, inst)
      const estimatedWaitMs = await this.estimateWait(totem, pos + 1)
      return { ok: true, status: 'queue', position: pos + 1, size, estimatedWaitMs }
    })
  }

  /**
   * WebSocket connect claims the session: reserved → active (play clock
   * starts). Rejects wrong player / finished / unknown sessions.
   * @returns {{ok:true, session}|{ok:false, error}}
   */
  async claim(sessionId, playerId) {
    const session = await this.repo.findById(sessionId)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.playerId !== playerId) return { ok: false, error: 'You are not allowed in this session' }
    if (session.status === 'finished') return { ok: false, error: 'Session already finished' }
    if (session.status === 'active') return { ok: true, session }

    return this._lock(session.totemId, session.instanceId, async () => {
      const activated = await this.repo.activate(sessionId)
      if (activated) {
        await this.cache.set(activated)
        await this._publishQueueEvent(session.totemId, session.instanceId)
        log.info({ sessionId, playerId }, 'Session claimed (reserved → active)')
        return { ok: true, session: activated }
      }
      const fresh = await this.repo.findById(sessionId)
      if (fresh?.status === 'active') return { ok: true, session: fresh }
      return { ok: false, error: 'Session already finished' }
    })
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Ends ONE player's session (death, kick, timeout, no_show, manual,
   * instance_closed) and advances that instance's queue into the freed slot.
   */
  async endSession(sessionId, reason = 'manual') {
    const session = await this.repo.findById(sessionId)
    if (!session) return { ok: false, code: 404, error: 'Session not found' }
    if (session.status === 'finished') return { ok: true, alreadyEnded: true }

    const inst = normalizeInstance(session.instanceId)
    return this._lock(session.totemId, inst, async () => {
      const ended = await this.repo.markEnded(sessionId, reason)
      if (!ended) return { ok: true, alreadyEnded: true }

      await this.cache.del(sessionId)
      this._fastify.gameHandler?.disconnectPlayer(sessionId, ended.playerId, 1008, 'Session ended')
      this._fastify.udpDispatcher?.unregisterSession(sessionId)
      this._sendPlayerLeave(ended)
      await this._publish(Channels.gameEvent(sessionId), 'event', sessionId, null, {
        event: 'session_ended', reason,
      })

      log.info({ sessionId, playerId: ended.playerId, instanceId: inst, reason }, 'Session ended')
      // Slot freed — the operator stream refreshes even if nobody is waiting.
      await this._publishQueueEvent(session.totemId, inst)

      // A closed instance has nobody left to advance into.
      if (reason !== 'instance_closed') {
        const totem = await this._totems.findTotem(session.totemId)
        if (totem) await this._advanceLocked(totem, inst)
      }
      return { ok: true }
    })
  }

  /** Ends every live session of the totem, across all instances. */
  async endAllForTotem(totemId, reason = 'manual') {
    const sessions = await this.repo.listCurrentByTotem(totemId)
    for (const s of sessions) await this.endSession(s._id, reason)
    return { ok: true, endedCount: sessions.length }
  }

  /** Operator reset of one instance: ends its live sessions, then advances. */
  async endAllForInstance(totemId, instanceId, reason = 'manual') {
    const sessions = await this.repo.listCurrentByInstance(totemId, instanceId)
    for (const s of sessions) await this.endSession(s._id, reason)
    return { ok: true, endedCount: sessions.length }
  }

  /**
   * An embedded iframe went away for good: end its sessions and drop its
   * waiting list. Waiting phones get a queue_changed ping and then a 410.
   */
  async dropInstance(totemId, instanceId) {
    if (isDefaultInstance(instanceId)) return { ok: false, error: 'Cannot drop the default instance' }
    const result = await this.endAllForInstance(totemId, instanceId, 'instance_closed')
    await this._lock(totemId, instanceId, async () => {
      if (this._redis) await this._redis.del(queueKey(totemId, instanceId))
      await this._publishQueueEvent(totemId, instanceId)
    })
    log.info({ totemId, instanceId, endedCount: result.endedCount }, 'Instance dropped')
    return result
  }

  /**
   * Fills free slots from the queue. Called on session end, on status polls,
   * and by the sweeper. MUST be called with the instance's lock already held.
   */
  async _advanceLocked(totem, instanceId) {
    if (!this._redis) return
    const totemId    = totem._id.toString()
    const maxPlayers = totem.maxPlayers ?? env.sessionMaxPlayers
    let advanced = 0

    while ((await this.repo.countCurrent(totemId, instanceId)) < maxPlayers) {
      const playerId = await this._redis.lpop(queueKey(totemId, instanceId))
      if (!playerId) break

      const alive = await this._redis.get(this._hbKey(playerId))
      if (!alive) {
        log.info({ totemId, instanceId, playerId }, 'Skipping ghost (heartbeat expired)')
        continue
      }

      let metadata = null
      try {
        const raw = await this._redis.get(this._mKey(playerId))
        metadata = raw ? JSON.parse(raw) : null
      } catch { /* metadata is best-effort */ }

      const joined = await this._redis.get(this._jKey(playerId))
      await this._redis.del(this._hbKey(playerId), this._jKey(playerId))
      const queuedAt = joined ? new Date(Number(joined)) : null
      const session = await this._createReserved(totem, instanceId, playerId, metadata, queuedAt)
      advanced++
      log.info({ totemId, instanceId, playerId, sessionId: session._id }, 'Queue advanced — slot reserved')
    }

    if (advanced > 0) await this._publishQueueEvent(totemId, instanceId)
  }

  /**
   * Expires unclaimed reservations (no_show) and out-of-time actives
   * (timeout). Runs every env.queueSweepMs — replaces the old watcher.
   */
  async sweep() {
    const expired = await this.repo.findExpired()
    for (const s of expired) {
      const reason = s.status === 'reserved' ? 'no_show' : 'timeout'
      await this.endSession(s._id, reason).catch(err =>
        log.error({ err: err.message, sessionId: s._id }, 'Sweep endSession failed'))
    }
  }

  // ── Queue management (operator) ──────────────────────────────────────────

  async kickFromQueue(totemId, instanceId, playerId) {
    const inst = normalizeInstance(instanceId)
    return this._lock(totemId, inst, async () => {
      if (!this._redis) return { ok: true }
      const removed = await this._redis.lrem(queueKey(totemId, inst), 0, playerId)
      await this._redis.del(this._hbKey(playerId))
      if (removed > 0) await this._publishQueueEvent(totemId, inst)
      return { ok: true, removed: removed > 0 }
    })
  }

  /** Clears the waiting list ONLY — live sessions are independent now. */
  async clearQueue(totemId, instanceId) {
    const inst = normalizeInstance(instanceId)
    return this._lock(totemId, inst, async () => {
      if (this._redis) {
        await this._redis.del(queueKey(totemId, inst))
        await this._publishQueueEvent(totemId, inst)
      }
      log.info({ totemId, instanceId: inst }, 'Queue cleared')
      return { ok: true }
    })
  }

  /** Dashboard/game HUD view of one instance: live sessions + waiting list. */
  async operatorView(totemId, instanceId) {
    const inst  = normalizeInstance(instanceId)
    const totem = await this._totems.findTotem(totemId)
    if (!totem) return { ok: false, code: 404, error: 'Totem not found' }

    const sessions = await this.repo.listCurrentByInstance(totemId, inst)
    const ids = this._redis ? await this._redis.lrange(queueKey(totemId, inst), 0, -1) : []
    const queue = await Promise.all(ids.map(async (pid, i) => {
      let metadata = null
      try {
        const raw = this._redis ? await this._redis.get(this._mKey(pid)) : null
        metadata = raw ? JSON.parse(raw) : null
      } catch { /* best-effort */ }
      return {
        id: pid,
        metadata,
        heartbeatTtl:    this._redis ? await this._redis.ttl(this._hbKey(pid)) : null,
        estimatedWaitMs: await this.estimateWait(totem, i + 1),
      }
    }))

    return {
      ok: true,
      instanceId: inst,
      sessions: sessions.map(s => ({
        sessionId: s._id,
        playerId:  s.playerId,
        status:    s.status,
        metadata:  s.metadata,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      })),
      queue,
      maxPlayers:   totem.maxPlayers ?? env.sessionMaxPlayers,
      maxQueueSize: totem.maxQueueSize ?? null,
    }
  }

  /** Live sessions + queue length of one instance (dashboard counters). */
  async instanceCounts(totemId, instanceId) {
    return {
      sessions:  await this.repo.countCurrent(totemId, instanceId),
      queueSize: await this._queueLen(totemId, instanceId),
    }
  }

  /** Finds a live session by the (possibly 8-char-truncated) pid the game knows. */
  async findCurrentByPidPrefix(totemId, instanceId, pid) {
    const sessions = await this.repo.listCurrentByInstance(totemId, instanceId)
    return sessions.find(s => s.playerId === pid || s.playerId.slice(0, 8) === pid.slice(0, 8)) ?? null
  }

  /** Rough ETA: rounds to wait × average real duration of recent rounds. */
  async estimateWait(totem, position) {
    const fallback = totem.sessionDurationMs ?? env.sessionTimeoutMs
    const recent = await this.repo.findRecentFinished(totem._id.toString(), 5)
    const durations = recent
      .filter(s => s.createdAt && s.endedAt)
      .map(s => new Date(s.endedAt).getTime() - new Date(s.createdAt).getTime())
      .filter(ms => ms > 0)
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : fallback
    const mp = totem.maxPlayers || 1
    return Math.ceil(position / mp) * avg
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _lock(totemId, instanceId, fn) {
    return this._mutex(instanceKey(totemId, instanceId), fn)
  }

  _hbKey(playerId) { return `queue:heartbeat:${playerId}` }
  _mKey(playerId)  { return `player:metadata:${playerId}` }
  _jKey(playerId)  { return `queue:joined:${playerId}` }

  /** Web instances must still be open (or within their grace period). */
  async _checkInstance(totemId, instanceId) {
    if (isDefaultInstance(instanceId)) return null
    if (await this._fastify.instances?.isLive(totemId, instanceId)) return null
    return { ok: false, code: 410, error: 'Instance closed' }
  }

  async _queueLen(totemId, instanceId) {
    if (!this._redis) return 0
    return this._redis.llen(queueKey(totemId, instanceId))
  }

  async _enqueue(totemId, instanceId, playerId, metadata) {
    const key = queueKey(totemId, instanceId)
    await this._redis.setex(this._hbKey(playerId), HEARTBEAT_SECS, '1')
    if (metadata) await this._redis.setex(this._mKey(playerId), HEARTBEAT_SECS, JSON.stringify(metadata))

    const pos = await this._redis.lpos(key, playerId)
    if (pos !== null) return pos + 1

    await this._redis.rpush(key, playerId)
    // When they joined — becomes session.queuedAt (wait-time stats).
    await this._redis.set(this._jKey(playerId), String(Date.now()), 'EX', 6 * 3600)
    await this._publishQueueEvent(totemId, instanceId)
    return this._redis.llen(key)
  }

  async _createReserved(totem, instanceId, playerId, metadata, queuedAt = null) {
    const totemId = totem._id.toString()
    const site = !isDefaultInstance(instanceId) && this._redis
      ? await this._redis.get(`inst:site:${instanceKey(totemId, instanceId)}`).catch(() => null)
      : null
    const session = await this.repo.create({
      totemId,
      instanceId,
      playerId,
      // UDP address only matters for the physical totem (default instance)
      totems:   isDefaultInstance(instanceId) && totem.ip
        ? [{ id: totem._id, ip: totem.ip, udpPort: totem.udpPort }]
        : [],
      metadata,
      reserveMs: env.queueReserveMs,
      playMs:    totem.sessionDurationMs ?? env.sessionTimeoutMs,
      queuedAt,
      site,
    })
    await this.cache.set(session)
    await this._publishQueueEvent(totemId, instanceId)
    return session
  }

  /** Tells the game to remove this player's avatar immediately. */
  _sendPlayerLeave(session) {
    this._fastify.gameOutput?.send(session, {
      type: 'player_leave',
      sid:  session._id.slice(0, 8),
      pid:  (session.playerId ?? '').slice(0, 8),
      tid:  session.totemId ?? null,
    }).catch(err => log.warn({ err: err.message, sessionId: session._id }, 'player_leave send failed'))
  }

  async _publishQueueEvent(totemId, instanceId) {
    if (!this._redis) return
    try {
      await this._redis.publish(queueEventChannel(totemId, instanceId), JSON.stringify({
        type: 'queue_changed', totemId, instanceId: normalizeInstance(instanceId), ts: Date.now(),
      }))
    } catch (err) {
      log.warn({ err: err.message, totemId, instanceId }, 'Queue event publish failed')
    }
  }

  async _publish(channel, type, sessionId, playerId, data) {
    if (!this._redis) return
    try {
      await this._redis.publish(channel, buildMessage(type, sessionId, playerId, data))
    } catch (err) {
      log.error({ err: err.message, channel }, 'Redis publish failed')
    }
  }
}
