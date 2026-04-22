// src/modules/session/session.service.js
// Business logic layer — sits between routes and the repository.
// Enforces rules: capacity, state machine, timeout.
//
// Session state machine:
//   waiting → active   (first player joins)
//   active  → finished (endSession or timeout)
//   finished stays in MongoDB forever (no TTL deletion)

import { SessionRepository } from './session.repository.js'
import { SessionCache }      from './session.cache.js'
import { Channels, buildMessage } from '../../lib/channels.js'
import { env } from '../../config/env.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('session.service')

export class SessionService {
  /**
   * @param {import('@fastify/mongodb').FastifyMongoObject} mongo
   * @param {import('ioredis').Redis} redisPublisher
   */
  constructor(mongo, redisPublisher) {
    this.repo        = new SessionRepository(mongo)
    this.cache       = new SessionCache(redisPublisher)
    this.publisher   = redisPublisher
    // Injected lazily to avoid circular dependency with TotemService
    this._TotemService = null
  }

  // ── Dependency injection ────────────────────────────────────────────────────

  /**
   * Injects the TotemService to enable auto-renew on session end.
   * @param {import('../totem/totem.service.js').TotemService} totemService
   */
  setTotemService(totemService) {
    this._TotemService = totemService
  }

  // ── Core operations ────────────────────────────────────────────────────────

  /**
   * Creates a new session and syncs it to Redis.
   * @param {{ totemId?: string, totems?: object[], maxPlayers?: number, ttlMs?: number, allowedPlayers?: string[] }} options
   * @returns {Promise<object>} Created session document
   */
  async createSession({ totemId, totems = [], maxPlayers, ttlMs, allowedPlayers = [] } = {}) {
    const session = await this.repo.createSession({ totemId, totems, maxPlayers, ttlMs, allowedPlayers })
    await this.cache.set(session)
    log.info({ sessionId: session._id, totemId: session.totemId }, 'Session created')
    return session
  }

  /**
   * Finds a session — Redis first, MongoDB fallback.
   * @param {string} sessionId
   * @returns {Promise<object|null>}
   */
  async findSession(sessionId) {
    const cached = await this.cache.get(sessionId)
    if (cached) return cached
    return this.repo.findById(sessionId)
  }

  /**
   * Lists all active and waiting sessions.
   * @returns {Promise<object[]>}
   */
  async listActiveSessions() {
    const all = await this.repo.listByStatus()
    return all.filter(s => s.status !== 'finished')
  }

  /**
   * Player joins a session.
   * Validates capacity and state before adding.
   * @param {string} sessionId
   * @param {string} playerId
   * @returns {Promise<{ok: boolean, error?: string, session?: object}>}
   */
  async joinSession(sessionId, playerId) {
    const session = await this.findSession(sessionId)

    if (!session) return { ok: false, error: 'Session not found' }
    if (session.status === 'finished') return { ok: false, error: 'Session already finished' }

    const currentPlayers = (session.players ?? []).length
    if (currentPlayers >= session.maxPlayers) return { ok: false, error: 'Session is full' }

    await this.repo.addPlayer(sessionId, playerId)

    // Refresh both Redis and MongoDB TTL on join
    await this.repo.refreshTtl(sessionId, env.sessionTimeoutMs)
    await this.cache.refreshTtl(sessionId, env.sessionTimeoutMs)

    const updated = await this.repo.findById(sessionId)
    await this.cache.set(updated)

    await this._publish(Channels.sessionSync(sessionId), 'sync', sessionId, playerId, {
      event: 'player_joined',
      playerId,
    })

    log.info({ sessionId, playerId }, 'Player joined session')
    return { ok: true, session: updated }
  }

  /**
   * Player leaves a session.
   * @param {string} sessionId
   * @param {string} playerId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async leaveSession(sessionId, playerId) {
    const session = await this.findSession(sessionId)
    if (!session) return { ok: false, error: 'Session not found' }

    await this.repo.removePlayer(sessionId, playerId)

    // If no players left and session was active, revert to waiting
    const remaining = (session.players ?? []).filter(p => p.id !== playerId)
    if (remaining.length === 0 && session.status === 'active') {
      await this.repo.updateStatus(sessionId, 'waiting')
    }

    const updated = await this.repo.findById(sessionId)
    if (updated) await this.cache.set(updated)

    await this._publish(Channels.sessionSync(sessionId), 'sync', sessionId, playerId, {
      event: 'player_left',
      playerId,
    })

    log.info({ sessionId, playerId }, 'Player left session')
    return { ok: true }
  }

  /**
   * Ends a session — marks as finished, publishes event, triggers auto-renew for the totem.
   * Sessions are NEVER hard-deleted; they persist for historical records.
   *
   * @param {string} sessionId
   * @param {'timeout'|'manual'} [reason='manual']
   * @returns {Promise<{ok: boolean, error?: string, newSessionId?: string}>}
   */
  async endSession(sessionId, reason = 'manual') {
    const session = await this.findSession(sessionId)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.status === 'finished') return { ok: true } // already ended

    // Mark as finished in MongoDB (document persists)
    await this.repo.markEnded(sessionId, reason)

    // Remove from Redis cache
    await this.cache.del(sessionId)

    await this._publish(Channels.gameEvent(sessionId), 'event', sessionId, null, {
      event: 'session_ended',
      reason,
    })

    log.info({ sessionId, reason }, 'Session ended')

    // Auto-renew: if this session belongs to a totem, start a new session
    let newSessionId
    if (session.totemId && this._TotemService) {
      try {
        const totem = await this._TotemService.findTotem(session.totemId)
        if (totem) {
          const result = await this._TotemService.startNewSession(totem)
          if (result.ok) newSessionId = result.session._id
        }
      } catch (err) {
        log.error({ err: err.message, totemId: session.totemId }, 'Auto-renew failed')
      }
    }

    return { ok: true, newSessionId }
  }

  /**
   * Hard-deletes a session from MongoDB and Redis.
   * Admin/cleanup use only. Prefer endSession() for normal flow.
   * @param {string} sessionId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async deleteSession(sessionId) {
    const exists = await this.findSession(sessionId)
    if (!exists) return { ok: false, error: 'Session not found' }

    await this.repo.deleteSession(sessionId)
    await this.cache.del(sessionId)

    log.info({ sessionId }, 'Session hard-deleted')
    return { ok: true }
  }

  // ── Session Timeout ────────────────────────────────────────────────────────

  /**
   * Resets the activity TTL for a session.
   * Called by GameHandler.onMessage() on every player input.
   * @param {string} sessionId
   */
  async refreshActivityTtl(sessionId) {
    await Promise.allSettled([
      this.repo.refreshTtl(sessionId, env.sessionTimeoutMs),
      this.cache.refreshTtl(sessionId, env.sessionTimeoutMs),
    ])
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  async _publish(channel, type, sessionId, playerId, data) {
    try {
      await this.publisher.publish(channel, buildMessage(type, sessionId, playerId, data))
    } catch (err) {
      log.error({ err: err.message, channel }, 'Redis publish failed')
    }
  }
}
