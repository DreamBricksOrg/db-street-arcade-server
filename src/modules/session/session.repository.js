// src/modules/session/session.repository.js
// Raw database operations for sessions collection.
// No business logic here — only CRUD against MongoDB.

import { v4 as uuidv4 } from 'uuid'
import { env } from '../../config/env.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('session.repository')

/**
 * Session document shape (reference):
 * {
 *   _id:        string,          // UUID v4 (sessionId)
 *   status:     'waiting'|'active'|'finished',
 *   totems:     Array<{ id: string, ip: string, udpPort: number }>,
 *   players:    Array<{ id: string, connectedAt: Date }>,
 *   maxPlayers: number,
 *   createdAt:  Date,
 *   expiresAt:  Date,            // TTL field — MongoDB deletes expired docs
 * }
 */

export class SessionRepository {
  /** @param {import('@fastify/mongodb').FastifyMongoObject} mongo */
  constructor(mongo) {
    this.col = mongo.client.db().collection('sessions')
  }

  /**
   * Creates a new session document.
   * @param {{ totems: object[], maxPlayers?: number, ttlMs?: number }} data
   * @returns {Promise<object>} The created session document
   */
  async createSession({ totems = [], maxPlayers, ttlMs }) {
    const now       = new Date()
    const resolvedTtl = ttlMs ?? env.sessionTimeoutMs
    const session = {
      _id:        uuidv4(),
      status:     'waiting',
      totems,
      players:    [],
      maxPlayers: maxPlayers ?? env.sessionMaxPlayers,
      createdAt:  now,
      expiresAt:  new Date(now.getTime() + resolvedTtl),
    }

    await this.col.insertOne(session)
    log.debug({ sessionId: session._id }, 'Session created')
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
   * Permanently deletes a session document.
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async deleteSession(sessionId) {
    const result = await this.col.deleteOne({ _id: sessionId })
    log.debug({ sessionId }, 'Session deleted')
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
}
