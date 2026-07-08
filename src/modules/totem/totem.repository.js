// src/modules/totem/totem.repository.js
// Raw CRUD operations for the `totems` collection.
// No business logic — only database access.

import { v4 as uuidv4 } from 'uuid'
import { createLogger }  from '../../lib/logger.js'

const log = createLogger('totem.repository')

/**
 * Totem document shape:
 * {
 *   _id:               string,      // UUID v4
 *   name:              string,      // ex: "Totem Cabine A"
 *   ip:                string,      // ex: "192.168.1.10"
 *   udpPort:           number,      // ex: 9001
 *   maxPlayers:        number,      // max players per session (default: 2)
 *   sessionDurationMs: number,      // session TTL in ms (default: 30 min)
 *   maxQueueSize:      number|null, // cap on waiting-list length (default: null = unlimited)
 *   createdAt:         Date,
 *   updatedAt:         Date,
 * }
 */

export class TotemRepository {
  /** @param {import('@fastify/mongodb').FastifyMongoObject} mongo */
  constructor(mongo) {
    this.col = mongo.client.db().collection('totems')
  }

  /**
   * Creates a new totem document.
   * @param {{ name: string, ip: string, udpPort: number, maxPlayers?: number, sessionDurationMs?: number, maxQueueSize?: number }} data
   * @returns {Promise<object>}
   */
  async create({ name, ip, udpPort, maxPlayers, sessionDurationMs, maxQueueSize }) {
    const now   = new Date()
    const totem = {
      _id:               uuidv4(),
      name,
      ip,
      udpPort,
      maxPlayers:        maxPlayers        ?? 2,
      sessionDurationMs: sessionDurationMs ?? 30 * 60 * 1000, // 30 min default
      maxQueueSize:      maxQueueSize      ?? null,           // null = unlimited
      createdAt:         now,
      updatedAt:         now,
    }
    await this.col.insertOne(totem)
    log.debug({ totemId: totem._id }, 'Totem created')
    return totem
  }

  /**
   * Lists all totems sorted by name.
   * @returns {Promise<object[]>}
   */
  async list() {
    return this.col.find({}, { sort: { name: 1 } }).toArray()
  }

  /**
   * Finds a totem by its ID.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findById(id) {
    return this.col.findOne({ _id: id })
  }

  /**
   * Updates allowed fields of an existing totem.
   * @param {string} id
   * @param {{ name?: string, ip?: string, udpPort?: number, maxPlayers?: number, sessionDurationMs?: number }} fields
   * @returns {Promise<boolean>} true if found and updated
   */
  async update(id, fields) {
    const result = await this.col.updateOne(
      { _id: id },
      { $set: { ...fields, updatedAt: new Date() } },
    )
    return result.matchedCount > 0
  }

  /**
   * Permanently deletes a totem document.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    const result = await this.col.deleteOne({ _id: id })
    log.debug({ totemId: id }, 'Totem deleted')
    return result.deletedCount > 0
  }
}
