// src/modules/session/session.repository.js
// Raw database operations for sessions collection.
// No business logic here — only CRUD against MongoDB.
//
// NOTE: Sessions are NEVER hard-deleted. The MongoDB TTL index has been removed.
// Sessions persist forever for historical records. Status transitions:
//   waiting → active → finished

import { v4 as uuidv4 } from 'uuid'
import { env } from '../../config/env.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('session.repository')

/**
 * Session document shape (reference):
 * {
 *   _id:        string,          // UUID v4 (sessionId)
 *   totemId:    string,          // ID of the owning totem
 *   status:     'waiting'|'active'|'finished',
 *   totems:     Array<{ id: string, ip: string, udpPort: number }>,
 *   players:    Array<{ id: string, connectedAt: Date }>,
 *   maxPlayers: number,
 *   createdAt:  Date,
 *   expiresAt:  Date,            // time limit — checked by watcher (NO TTL index)
 *   endedAt:    Date|null,       // set when finished
 *   endReason:  'timeout'|'manual'|null,
 * }
 */

export class SessionRepository {
  /** @param {import('@fastify/mongodb').FastifyMongoObject} mongo */
  constructor(mongo) {
    this.col = mongo.client.db().collection('sessions')
  }

  /**
   * Creates a new session document.
   * @param {{ totemId?: string, totems?: object[], maxPlayers?: number, ttlMs?: number, allowedPlayers?: string[] }} data
   * @returns {Promise<object>} The created session document
   */
  async createSession({ totemId, totems = [], maxPlayers, ttlMs, allowedPlayers = [] }) {
    const now         = new Date()
    const resolvedTtl = ttlMs ?? env.sessionTimeoutMs
    const session = {
      _id:            uuidv4(),
      totemId:        totemId ?? null,
      status:         'waiting',
      totems,
      players:        [],
      allowedPlayers: allowedPlayers,
      maxPlayers:     maxPlayers ?? env.sessionMaxPlayers,
      gameDurationMs: resolvedTtl,
      createdAt:      now,
      expiresAt:  new Date(now.getTime() + resolvedTtl),
      endedAt:    null,
      endReason:  null,
    }

    await this.col.insertOne(session)
    log.debug({ sessionId: session._id, totemId: session.totemId }, 'Session created')
    return session
  }

  /**
   * Finds a session by its ID.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    return this.col.findOne({ _id: id })
  }

  /**
   * Adds a player entry to the players array.
   * @param {string} sessionId
   * @param {string} playerId
   * @returns {Promise<boolean>} True if the document was found and updated
   */
  async addPlayer(sessionId, playerId) {
    const result = await this.col.updateOne(
      { _id: sessionId },
      {
        $push: { players: { id: playerId, connectedAt: new Date() } },
        $set:  { status: 'active' },
      },
    )
    return result.matchedCount > 0
  }

  /**
   * Removes a player from the players array.
   * @param {string} sessionId
   * @param {string} playerId
   * @returns {Promise<boolean>}
   */
  async removePlayer(sessionId, playerId) {
    const result = await this.col.updateOne(
      { _id: sessionId },
      { $pull: { players: { id: playerId } } },
    )
    return result.matchedCount > 0
  }

  /**
   * Updates the session status field.
   * @param {string} sessionId
   * @param {'waiting'|'active'|'finished'} status
   * @returns {Promise<boolean>}
   */
  async updateStatus(sessionId, status) {
    const result = await this.col.updateOne(
      { _id: sessionId },
      { $set: { status } },
    )
    return result.matchedCount > 0
  }

  /**
   * Marks a session as finished with reason and timestamp.
   * Archives the final state (players, allowedPlayers) to MongoDB.
   * @param {string} sessionId
   * @param {'timeout'|'manual'} reason
   * @param {object} [finalState] - The latest session state from Redis
   * @returns {Promise<boolean>}
   */
  async markEnded(sessionId, reason, finalState = {}) {
    const update = {
      status:    'finished',
      endedAt:   new Date(),
      endReason: reason,
    }

    // Archive dynamic fields from Redis if provided
    if (finalState.players)        update.players        = finalState.players
    if (finalState.allowedPlayers) update.allowedPlayers = finalState.allowedPlayers

    const result = await this.col.updateOne(
      { _id: sessionId },
      { $set: update },
    )
    return result.matchedCount > 0
  }

  /**
   * Extends the session TTL by resetting expiresAt.
   * Called whenever a player sends an input (activity heartbeat).
   * @param {string} sessionId
   * @param {number} [ttlMs]
   */
  async refreshTtl(sessionId, ttlMs) {
    const resolvedTtl = ttlMs ?? env.sessionTimeoutMs
    await this.col.updateOne(
      { _id: sessionId },
      { $set: { expiresAt: new Date(Date.now() + resolvedTtl) } },
    )
  }

  /**
   * Hard-deletes a session. Retained for admin/cleanup purposes only.
   * Normal flow should use markEnded() instead.
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async deleteSession(sessionId) {
    const result = await this.col.deleteOne({ _id: sessionId })
    log.debug({ sessionId }, 'Session hard-deleted')
    return result.deletedCount > 0
  }

  /**
   * Lists all sessions with a given status.
   * @param {'waiting'|'active'|'finished'} [status]
   * @returns {Promise<object[]>}
   */
  async listByStatus(status) {
    const filter = status ? { status } : {}
    return this.col.find(filter, { sort: { createdAt: -1 }, limit: 100 }).toArray()
  }

  /**
   * Returns the most recently finished sessions for a totem.
   * Used to estimate queue wait time from actual past round durations.
   * @param {string} totemId
   * @param {number} [limit=5]
   * @returns {Promise<object[]>}
   */
  async findRecentFinished(totemId, limit = 5) {
    return this.col.find(
      { totemId, status: 'finished', endedAt: { $ne: null } },
      { sort: { endedAt: -1 }, limit },
    ).toArray()
  }
}
