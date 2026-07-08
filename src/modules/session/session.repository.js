// src/modules/session/session.repository.js
// Raw database operations for the sessions collection.
// A session is ONE player's connection to ONE totem:
//   reserved → active → finished        (normal flow)
//   reserved → finished (no_show/kick)  (never claimed)
// Finished sessions persist forever for historical records.

import { v4 as uuidv4 } from 'uuid'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('session.repository')

const CURRENT = ['reserved', 'active']

export class SessionRepository {
  /** @param {import('@fastify/mongodb').FastifyMongoObject} mongo */
  constructor(mongo) {
    this.col = mongo.client.db().collection('sessions')
  }

  /**
   * Creates a session in 'reserved' state for a single player.
   * @param {{ totemId: string, playerId: string, totems: Array<{id, ip, udpPort}>,
   *           metadata?: object|null, reserveMs: number, playMs: number }} data
   */
  async create({ totemId, playerId, totems, metadata = null, reserveMs, playMs }) {
    const now = new Date()
    const session = {
      _id:            uuidv4(),
      totemId,
      playerId,
      status:         'reserved',
      totems,
      metadata,
      gameDurationMs: playMs,
      createdAt:      now,
      reservedUntil:  new Date(now.getTime() + reserveMs),
      expiresAt:      new Date(now.getTime() + reserveMs + playMs),
      endedAt:        null,
      endReason:      null,
    }
    await this.col.insertOne(session)
    log.debug({ sessionId: session._id, totemId, playerId }, 'Session created (reserved)')
    return session
  }

  async findById(id) {
    return this.col.findOne({ _id: id })
  }

  /** The player's live (reserved or active) session on this totem, if any. */
  async findCurrentByPlayer(totemId, playerId) {
    return this.col.findOne({ totemId, playerId, status: { $in: CURRENT } })
  }

  /** All live sessions of a totem, oldest first. */
  async listCurrentByTotem(totemId) {
    return this.col.find({ totemId, status: { $in: CURRENT } }, { sort: { createdAt: 1 } }).toArray()
  }

  async countCurrent(totemId) {
    return this.col.countDocuments({ totemId, status: { $in: CURRENT } })
  }

  /** All live sessions across every totem (operator listing). */
  async listCurrentAll(limit = 100) {
    return this.col.find({ status: { $in: CURRENT } }, { sort: { createdAt: -1 }, limit }).toArray()
  }

  /**
   * reserved → active. The play clock starts NOW (expiresAt is reset from
   * claim time, not creation time). Returns the updated doc or null if the
   * session wasn't in 'reserved' (already active, finished, or missing).
   */
  async activate(id) {
    const doc = await this.col.findOne({ _id: id })
    if (!doc || doc.status !== 'reserved') return null
    return this.col.findOneAndUpdate(
      { _id: id, status: 'reserved' },
      { $set: { status: 'active', expiresAt: new Date(Date.now() + doc.gameDurationMs) } },
      { returnDocument: 'after' },
    )
  }

  /** → finished. Returns updated doc, or null if it was already finished. */
  async markEnded(id, reason) {
    return this.col.findOneAndUpdate(
      { _id: id, status: { $in: CURRENT } },
      { $set: { status: 'finished', endedAt: new Date(), endReason: reason } },
      { returnDocument: 'after' },
    )
  }

  /** Sessions past their deadline: unclaimed reservations and out-of-time actives. */
  async findExpired(now = new Date()) {
    return this.col.find({
      $or: [
        { status: 'reserved', reservedUntil: { $lte: now } },
        { status: 'active',   expiresAt:     { $lte: now } },
      ],
    }).toArray()
  }

  /** Recent finished rounds of a totem — used for queue wait estimates. */
  async findRecentFinished(totemId, limit = 5) {
    return this.col.find(
      { totemId, status: 'finished', endedAt: { $ne: null } },
      { sort: { endedAt: -1 }, limit },
    ).toArray()
  }

  /** Hard delete (admin cleanup only). */
  async delete(id) {
    const result = await this.col.deleteOne({ _id: id })
    return result.deletedCount > 0
  }
}
