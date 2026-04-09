// src/modules/session/session.service.js
// TASK-S6.1 — Session Service
//
// Business logic layer — sits between routes and the repository.
// Enforces rules: capacity, state machine, timeout.
//
// Session state machine:
//   waiting → active  (first player joins)
//   active  → finished (endSession or timeout)
//   finished → (deleted after TTL or manual delete)

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
    this.repo      = new SessionRepository(mongo)
    this.cache     = new SessionCache(redisPublisher)
    this.publisher = redisPublisher
  }

  // ── TASK-S6.1 operations ────────────────────────────────────────────────────

  /**
   * Creates a new session and syncs it to Redis.
   * @param {{ totems?: object[], maxPlayers?: number }} options
   * @returns {Promise<object>} Created session document
   */
  async createSession({ totems = [], maxPlayers } = {}) {
    const session = await this.repo.createSession({ totems, maxPlayers })
    await this.cache.set(session)
    log.info({ sessionId: session._id }, 'Session created')
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
    // A query for all not-finished ones would be better, but we can do listByStatus and filter.
    // Actually repo.listByStatus() with no args fetches all. Let's just fetch all and filter in JS for now
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
   * Ends a session — marks as finished, publishes event, cleanup handled by TTL.
   * @param {string} sessionId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async endSession(sessionId) {
    const session = await this.findSession(sessionId)
    if (!session) return { ok: false, error: 'Session not found' }

    await this.repo.updateStatus(sessionId, 'finished')

    // Proactively delete from Redis — no need to wait for TTL
    await this.cache.del(sessionId)

    await this._publish(Channels.gameEvent(sessionId), 'event', sessionId, null, {
      event: 'session_ended',
    })

    log.info({ sessionId }, 'Session ended')
    return { ok: true }
  }

  /**
   * Hard-deletes a session from MongoDB and Redis.
   * @param {string} sessionId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async deleteSession(sessionId) {
    const exists = await this.findSession(sessionId)
    if (!exists) return { ok: false, error: 'Session not found' }

    await this.repo.deleteSession(sessionId)
    await this.cache.del(sessionId)

    log.info({ sessionId }, 'Session deleted')
    return { ok: true }
  }

  // ── S6.3: Session Timeout ───────────────────────────────────────────────────

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
