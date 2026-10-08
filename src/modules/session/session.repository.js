// src/modules/session/session.repository.js
// Raw database operations for the sessions collection.
// A session is ONE player's connection to ONE instance of a totem:
//   reserved → active → finished        (normal flow)
//   reserved → finished (no_show/kick)  (never claimed)
// Finished sessions persist forever for historical records.
//
// instanceId: 'default' = physical totem; anything else = an embedded iframe.
// Docs created before n→n have no instanceId and count as 'default'.

import { v4 as uuidv4 } from 'uuid'
import { createLogger } from '../../lib/logger.js'
import { normalizeInstance, isDefaultInstance, DEFAULT_INSTANCE } from '../../lib/channels.js'

const log = createLogger('session.repository')

const CURRENT = ['reserved', 'active']

const instFilter = (instanceId) => (isDefaultInstance(instanceId)
  ? { instanceId: { $in: [DEFAULT_INSTANCE, null] } }
  : { instanceId: String(instanceId) })

export class SessionRepository {
  /** @param {import('@fastify/mongodb').FastifyMongoObject} mongo */
  constructor(mongo) {
    this.col = mongo.client.db().collection('sessions')
  }

  /**
   * Creates a session in 'reserved' state for a single player.
   * @param {{ totemId: string, instanceId?: string, playerId: string, totems: Array<{id, ip, udpPort}>,
   *           metadata?: object|null, reserveMs: number, playMs: number }} data
   */
  async create({ totemId, instanceId, playerId, totems, metadata = null, reserveMs, playMs, queuedAt = null, site = null, nickname = null }) {
    const now = new Date()
    const session = {
      _id:            uuidv4(),
      totemId,
      instanceId:     normalizeInstance(instanceId),
      playerId,
      nickname,                     // anonymous animal name ("Capivara Veloz")
      status:         'reserved',
      totems,
      metadata,
      gameDurationMs: playMs,
      queuedAt,                     // joined the waiting list (null = played straight away)
      site,                         // embedding site's origin (web instances, for stats)
      startedAt:      null,         // phone connected (reserved → active)
      createdAt:      now,
      reservedUntil:  new Date(now.getTime() + reserveMs),
      expiresAt:      new Date(now.getTime() + reserveMs + playMs),
      endedAt:        null,
      endReason:      null,
    }
    await this.col.insertOne(session)
    log.debug({ sessionId: session._id, totemId, instanceId: session.instanceId, playerId }, 'Session created (reserved)')
    return session
  }

  /**
   * Best scores (totemId = null → every totem). Ties: who got there first.
   * @returns {Promise<Array<{ nickname, score, endedAt, totemId, instanceId, site }>>}
   */
  async listRanking({ totemId = null, since = null, limit = 10 } = {}) {
    const q = { score: { $type: 'number' } }
    if (totemId) q.totemId = totemId
    if (since) q.endedAt = { $gte: since }
    return this.col.find(q, {
      projection: { _id: 0, nickname: 1, score: 1, endedAt: 1, totemId: 1, instanceId: 1, site: 1 },
      sort: { score: -1, endedAt: 1 },
      limit,
    }).toArray()
  }

  /**
   * Sessions created since `since` (totemId null = every totem) — light
   * projection for stats and CSV export, oldest first.
   */
  async listForStats(totemId, since, limit = 100_000) {
    return this.col.find(
      { ...(totemId ? { totemId } : {}), createdAt: { $gte: since } },
      {
        projection: { totemId: 1, instanceId: 1, status: 1, createdAt: 1, queuedAt: 1, startedAt: 1, endedAt: 1, endReason: 1, site: 1, nickname: 1, score: 1 },
        sort: { createdAt: 1 },
        limit,
      },
    ).toArray()
  }

  async findById(id) {
    return this.col.findOne({ _id: id })
  }

  /** The player's live (reserved or active) session on this instance, if any. */
  async findCurrentByPlayer(totemId, instanceId, playerId) {
    return this.col.findOne({ totemId, ...instFilter(instanceId), playerId, status: { $in: CURRENT } })
  }

  /** All live sessions of one instance, oldest first. */
  async listCurrentByInstance(totemId, instanceId) {
    return this.col.find(
      { totemId, ...instFilter(instanceId), status: { $in: CURRENT } },
      { sort: { createdAt: 1 } },
    ).toArray()
  }

  /** All live sessions of a totem across every instance, oldest first. */
  async listCurrentByTotem(totemId) {
    return this.col.find({ totemId, status: { $in: CURRENT } }, { sort: { createdAt: 1 } }).toArray()
  }

  async countCurrent(totemId, instanceId) {
    return this.col.countDocuments({ totemId, ...instFilter(instanceId), status: { $in: CURRENT } })
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
      { $set: { status: 'active', startedAt: new Date(), expiresAt: new Date(Date.now() + doc.gameDurationMs) } },
      { returnDocument: 'after' },
    )
  }

  /** → finished. Returns updated doc, or null if it was already finished. */
  async markEnded(id, reason, { score = null } = {}) {
    return this.col.findOneAndUpdate(
      { _id: id, status: { $in: CURRENT } },
      { $set: { status: 'finished', endedAt: new Date(), endReason: reason, ...(score !== null ? { score } : {}) } },
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
