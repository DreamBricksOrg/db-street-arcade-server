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
   * Lists all active and waiting sessions, merging live state from Redis.
   * @returns {Promise<object[]>}
   */
  async listActiveSessions() {
    const sessions = await this.repo.listByStatus()
    const active = sessions.filter(s => s.status !== 'finished')

    // Merge live state from Redis for each active session
    return Promise.all(active.map(async (s) => {
      const cached = await this.cache.get(s._id)
      return cached || s
    }))
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

    const currentPlayers = (session.players ?? [])
    const isAlreadyIn = currentPlayers.some(p => p.id === playerId)

    if (!isAlreadyIn && currentPlayers.length >= session.maxPlayers) {
      return { ok: false, error: 'Session is full' }
    }

    // Update in-memory object if not already there
    if (!isAlreadyIn) {
      currentPlayers.push({ id: playerId, connectedAt: new Date() })
      session.players = currentPlayers
    }
    
    // Transition status if needed
    if (session.status === 'waiting') {
      session.status = 'active'
    }

    // Refresh TTL and Save to Redis only
    const ttlMs = session.gameDurationMs || env.sessionTimeoutMs
    session.expiresAt = new Date(Date.now() + ttlMs)
    await this.cache.set(session)

    await this._publish(Channels.sessionSync(sessionId), 'sync', sessionId, playerId, {
      event: 'player_joined',
      playerId,
    })

    log.info({ sessionId, playerId, status: session.status }, 'Player joined session (Redis-only)')
    return { ok: true, session }
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

    // Update in-memory object
    session.players = (session.players ?? []).filter(p => p.id !== playerId)
    
    // If no players left and session was active, revert to waiting
    if (session.players.length === 0 && session.status === 'active') {
      session.status = 'waiting'
    }

    await this.cache.set(session)

    await this._publish(Channels.sessionSync(sessionId), 'sync', sessionId, playerId, {
      event: 'player_left',
      playerId,
    })

    log.info({ sessionId, playerId, status: session.status }, 'Player left session (Redis-only)')
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

    // ARCHIVE: Save final state to MongoDB
    await this.repo.markEnded(sessionId, reason, session)

    // Remove from Redis cache
    await this.cache.del(sessionId)

    await this._publish(Channels.gameEvent(sessionId), 'event', sessionId, null, {
      event: 'session_ended',
      reason,
    })

    log.info({ sessionId, reason, playersCount: (session.players ?? []).length }, 'Session ended and archived to MongoDB')

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
   * Called when a player dies in a game that supports respawn (e.g. demo-snake).
   * If someone is waiting in the totem's queue, ends the session immediately so
   * the auto-renew mechanism can advance the queue to the next player.
   *
   * @param {string} sessionId
   * @returns {Promise<{ shouldEnd: boolean, newSessionId?: string }>}
   */
  async playerDied(sessionId) {
    const session = await this.findSession(sessionId)
    if (!session || session.status === 'finished') return { shouldEnd: false }
    if (!session.totemId || !this._TotemService) return { shouldEnd: false }

    const queueSize = await this._TotemService.getQueueSize(session.totemId)
    if (queueSize <= 0) return { shouldEnd: false }

    const result = await this.endSession(sessionId, 'player_died')
    return { shouldEnd: true, newSessionId: result.newSessionId }
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
    await this.cache.refreshTtl(sessionId, env.sessionTimeoutMs)
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
