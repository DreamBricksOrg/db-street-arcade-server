// src/modules/session/session.cache.js
// Redis cache layer for sessions.
// Stores a fast-access HASH of the session state so the WebSocket handler
// doesn't need a MongoDB round-trip on every connection or input event.
//
// Key format: session:{sessionId}  (see src/lib/channels.js → SessionKey)
// TTL mirrors the MongoDB TTL field so both expire at roughly the same time.

import { SessionKey } from '../../lib/channels.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('session.cache')

export class SessionCache {
  /**
   * @param {import('ioredis').Redis} redis - The publisher client (can run SET/GET commands)
   */
  constructor(redis) {
    this.redis = redis
  }

  /**
   * Writes the session snapshot to Redis as a HASH with TTL.
   * Called after createSession or whenever session state changes.
   * @param {object} session - Mongo session document
   */
  async set(session) {
    const key     = SessionKey(session._id)
    const ttlSecs = Math.max(
      1,
      Math.floor((new Date(session.expiresAt) - Date.now()) / 1000),
    )

    // HSET accepts alternating field/value pairs
    await this.redis.hset(key, {
      id:         session._id,
      status:     session.status,
      maxPlayers: String(session.maxPlayers),
      // Serialize arrays as JSON strings — Redis HASH values must be strings
      totems:     JSON.stringify(session.totems ?? []),
      players:    JSON.stringify(session.players ?? []),
      expiresAt:  String(new Date(session.expiresAt).getTime()),
    })

    await this.redis.expire(key, ttlSecs)
    log.debug({ sessionId: session._id, ttlSecs }, 'Session cached')
  }

  /**
   * Retrieves the session snapshot from Redis.
   * Returns null if the key doesn't exist (expired or never cached).
   * @param {string} sessionId
   * @returns {Promise<object|null>}
   */
  async get(sessionId) {
    const raw = await this.redis.hgetall(SessionKey(sessionId))

    // hgetall returns {} for missing keys
    if (!raw || !raw.id) return null

    return {
      id:         raw.id,
      status:     raw.status,
      maxPlayers: parseInt(raw.maxPlayers, 10),
      totems:     JSON.parse(raw.totems),
      players:    JSON.parse(raw.players),
      expiresAt:  new Date(parseInt(raw.expiresAt, 10)),
    }
  }

  /**
   * Updates a single field in the session HASH without a full re-write.
   * Useful for frequent small updates (e.g. status change).
   * @param {string} sessionId
   * @param {string} field
   * @param {string} value
   */
  async patch(sessionId, field, value) {
    const key = SessionKey(sessionId)
    await this.redis.hset(key, field, value)
  }

  /**
   * Extends the session TTL in Redis (called on player input to prevent expiry).
   * @param {string} sessionId
   * @param {number} ttlMs
   */
  async refreshTtl(sessionId, ttlMs) {
    const ttlSecs = Math.max(1, Math.floor(ttlMs / 1000))
    await this.redis.expire(SessionKey(sessionId), ttlSecs)
    log.debug({ sessionId, ttlSecs }, 'Session TTL refreshed')
  }

  /**
   * Removes the session HASH from Redis immediately.
   * Called when a session ends or is deleted.
   * @param {string} sessionId
   */
  async del(sessionId) {
    await this.redis.del(SessionKey(sessionId))
    log.debug({ sessionId }, 'Session cache cleared')
  }
}
