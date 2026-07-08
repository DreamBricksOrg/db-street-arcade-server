// src/modules/totem/totemQueue.service.js
// Single owner of the queue→session→slot lifecycle.
//
// Model: one session per player. A totem with maxPlayers=N holds up to N
// live sessions (reserved|active). When any session ends, advance() pops the
// next living player from the Redis queue and reserves a fresh session for
// them (they have env.queueReserveMs to claim it via WebSocket connect).
//
// Every mutating public method serializes on a per-totem mutex so concurrent
// requests can never double-book a slot or duplicate sessions.
// IMPORTANT: methods named *_Locked assume the totem lock is already held and
// must never call this._lock themselves (the keyed mutex is not re-entrant).

import { SessionRepository } from '../session/session.repository.js'
import { SessionCache }      from '../session/session.cache.js'
import { Channels, buildMessage } from '../../lib/channels.js'
import { createKeyedMutex }  from '../../lib/mutex.js'
import { env }               from '../../config/env.js'
import { createLogger }      from '../../lib/logger.js'

const log = createLogger('totem.queue')

const HEARTBEAT_SECS = 120

export class TotemQueueService {
  /**
   * @param {import('fastify').FastifyInstance} fastify  (mongo, redisPublisher; gameHandler/udpSend/udpDispatcher lazily at call time)
   * @param {import('./totem.service.js').TotemService} totemService
   */
  constructor(fastify, totemService) {
    this._fastify = fastify
    this._totems  = totemService
    this.repo     = new SessionRepository(fastify.mongo)
    this.cache    = new SessionCache(fastify.redisPublisher)
    this._redis   = fastify.redisPublisher ?? null
    this._lock    = createKeyedMutex()
  }

  // ── Player-facing ────────────────────────────────────────────────────────

  /**
   * Player scans the QR / retries. Idempotent: an existing live session for
   * this player is returned as-is.
   * @returns {{ok:true,status:'play',sessionId}|{ok:true,status:'queue',position,estimatedWaitMs}|{ok:false,code,error}}
   */
  async join(totemId, playerId, metadata = null) {
    return this._lock(totemId, () => this._joinLocked(totemId, playerId, metadata))
  }

  async _joinLocked(totemId, playerId, metadata) {
    const totem = await this._totems.findTotem(totemId)
    if (!totem) return { ok: false, code: 404, error: 'Totem not found' }

    const existing = await this.repo.findCurrentByPlayer(totemId, playerId)
    if (existing) return { ok: true, status: 'play', sessionId: existing._id }

    const maxPlayers = totem.maxPlayers ?? env.sessionMaxPlayers
    const occupied   = await this.repo.countCurrent(totemId)
    const queueSize  = await this._queueLen(totemId)

    if (occupied < maxPlayers && queueSize === 0) {
      const session = await this._createReserved(totem, playerId, metadata)
      return { ok: true, status: 'play', sessionId: session._id }
    }

    if (!this._redis) return { ok: false, code: 503, error: 'Queue unavailable (Redis offline)' }
    if (totem.maxQueueSize && queueSize >= totem.maxQueueSize) {
      return { ok: false, code: 409, error: 'Queue is full' }
    }

    const position = await this._enqueue(totemId, playerId, metadata)
    const estimatedWaitMs = await this.estimateWait(totem, position)
    return { ok: true, status: 'queue', position, estimatedWaitMs }
  }

  /**
   * Poll from the waiting screen. Refreshes the heartbeat, self-heals by
   * advancing if slots are free, and reports 'play' once a session exists.
   */
  async status(totemId, playerId) {
    return this._lock(totemId, async () => {
      const totem = await this._totems.findTotem(totemId)
      if (!totem) return { ok: false, code: 404, error: 'Totem not found' }

      let session = await this.repo.findCurrentByPlayer(totemId, playerId)
      if (!session) {
        if (this._redis) await this._redis.setex(this._hbKey(playerId), HEARTBEAT_SECS, '1')
        await this._advanceLocked(totem)
        session = await this.repo.findCurrentByPlayer(totemId, playerId)
      }
      if (session) return { ok: true, status: 'play', sessionId: session._id }

      if (!this._redis) return { ok: false, code: 404, error: 'Not in queue' }
      const pos = await this._redis.lpos(this._qKey(totemId), playerId)
      if (pos === null) return { ok: false, code: 404, error: 'Not in queue' }

      const size = await this._queueLen(totemId)
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

    return this._lock(session.totemId, async () => {
      const activated = await this.repo.activate(sessionId)
      if (activated) {
        await this.cache.set(activated)
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
   * Ends ONE player's session (death, kick, timeout, no_show, manual) and
   * advances the queue into the freed slot.
   */
  async endSession(sessionId, reason = 'manual') {
    const session = await this.repo.findById(sessionId)
    if (!session) return { ok: false, code: 404, error: 'Session not found' }
    if (session.status === 'finished') return { ok: true, alreadyEnded: true }

    return this._lock(session.totemId, async () => {
      const ended = await this.repo.markEnded(sessionId, reason)
      if (!ended) return { ok: true, alreadyEnded: true }

      await this.cache.del(sessionId)
      this._fastify.gameHandler?.disconnectPlayer(sessionId, ended.playerId, 1008, 'Session ended')
      this._fastify.udpDispatcher?.unregisterSession(sessionId)
      this._sendPlayerLeave(ended)
      await this._publish(Channels.gameEvent(sessionId), 'event', sessionId, null, {
        event: 'session_ended', reason,
      })

      log.info({ sessionId, playerId: ended.playerId, reason }, 'Session ended')

      const totem = await this._totems.findTotem(session.totemId)
      if (totem) await this._advanceLocked(totem)
      return { ok: true }
    })
  }

  /** Operator reset: ends every live session of the totem, then advances. */
  async endAllForTotem(totemId, reason = 'manual') {
    const sessions = await this.repo.listCurrentByTotem(totemId)
    for (const s of sessions) await this.endSession(s._id, reason)
    return { ok: true, endedCount: sessions.length }
  }

  /**
   * Fills free slots from the queue. Called on session end, on status polls,
   * and by the sweeper. MUST be called with the totem's lock already held.
   */
  async _advanceLocked(totem) {
    if (!this._redis) return
    const totemId    = totem._id.toString()
    const maxPlayers = totem.maxPlayers ?? env.sessionMaxPlayers
    let advanced = 0

    while ((await this.repo.countCurrent(totemId)) < maxPlayers) {
      const playerId = await this._redis.lpop(this._qKey(totemId))
      if (!playerId) break

      const alive = await this._redis.get(this._hbKey(playerId))
      if (!alive) {
        log.info({ totemId, playerId }, 'Skipping ghost (heartbeat expired)')
        continue
      }

      let metadata = null
      try {
        const raw = await this._redis.get(this._mKey(playerId))
        metadata = raw ? JSON.parse(raw) : null
      } catch { /* metadata is best-effort */ }

      await this._redis.del(this._hbKey(playerId))
      const session = await this._createReserved(totem, playerId, metadata)
      advanced++
      log.info({ totemId, playerId, sessionId: session._id }, 'Queue advanced — slot reserved')
    }

    if (advanced > 0) await this._publishQueueEvent(totemId)
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

  async kickFromQueue(totemId, playerId) {
    return this._lock(totemId, async () => {
      if (!this._redis) return { ok: true }
      const removed = await this._redis.lrem(this._qKey(totemId), 0, playerId)
      await this._redis.del(this._hbKey(playerId))
      if (removed > 0) await this._publishQueueEvent(totemId)
      return { ok: true, removed: removed > 0 }
    })
  }

  /** Clears the waiting list ONLY — live sessions are independent now. */
  async clearQueue(totemId) {
    return this._lock(totemId, async () => {
      if (this._redis) {
        await this._redis.del(this._qKey(totemId))
        await this._publishQueueEvent(totemId)
      }
      log.info({ totemId }, 'Queue cleared')
      return { ok: true }
    })
  }

  /** Dashboard view: live sessions + waiting list with metadata/TTL/ETA. */
  async operatorView(totemId) {
    const totem = await this._totems.findTotem(totemId)
    if (!totem) return { ok: false, code: 404, error: 'Totem not found' }

    const sessions = await this.repo.listCurrentByTotem(totemId)
    const ids = this._redis ? await this._redis.lrange(this._qKey(totemId), 0, -1) : []
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

  /** Finds a live session by the (possibly 8-char-truncated) pid the game knows. */
  async findCurrentByPidPrefix(totemId, pid) {
    const sessions = await this.repo.listCurrentByTotem(totemId)
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

  _qKey(totemId)   { return `queue:totem:${totemId}` }
  _hbKey(playerId) { return `queue:heartbeat:${playerId}` }
  _mKey(playerId)  { return `player:metadata:${playerId}` }

  async _queueLen(totemId) {
    if (!this._redis) return 0
    return this._redis.llen(this._qKey(totemId))
  }

  async _enqueue(totemId, playerId, metadata) {
    await this._redis.setex(this._hbKey(playerId), HEARTBEAT_SECS, '1')
    if (metadata) await this._redis.setex(this._mKey(playerId), HEARTBEAT_SECS, JSON.stringify(metadata))

    const pos = await this._redis.lpos(this._qKey(totemId), playerId)
    if (pos !== null) return pos + 1

    await this._redis.rpush(this._qKey(totemId), playerId)
    await this._publishQueueEvent(totemId)
    return this._redis.llen(this._qKey(totemId))
  }

  async _createReserved(totem, playerId, metadata) {
    const session = await this.repo.create({
      totemId:  totem._id.toString(),
      playerId,
      totems:   [{ id: totem._id, ip: totem.ip, udpPort: totem.udpPort }],
      metadata,
      reserveMs: env.queueReserveMs,
      playMs:    totem.sessionDurationMs ?? env.sessionTimeoutMs,
    })
    await this.cache.set(session)
    await this._publishQueueEvent(totem._id.toString())
    return session
  }

  /** Tells the game (via UDP) to remove this player's avatar immediately. */
  _sendPlayerLeave(session) {
    const packet = JSON.stringify({
      type: 'player_leave',
      sid:  session._id.slice(0, 8),
      pid:  (session.playerId ?? '').slice(0, 8),
      tid:  session.totemId ?? null,
    })
    for (const t of session.totems ?? []) {
      this._fastify.udpSend?.(t.ip, t.udpPort, packet).catch(err =>
        log.warn({ err: err.message, ip: t.ip }, 'UDP player_leave failed'))
    }
  }

  async _publishQueueEvent(totemId) {
    if (!this._redis) return
    try {
      await this._redis.publish(`queue:event:${totemId}`, JSON.stringify({ type: 'queue_changed', totemId, ts: Date.now() }))
    } catch (err) {
      log.warn({ err: err.message, totemId }, 'Queue event publish failed')
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
