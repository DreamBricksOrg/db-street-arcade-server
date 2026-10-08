// src/modules/totem/totem.service.js
// CRUD-only business logic for totems. The queue/session lifecycle lives in
// totemQueue.service.js — this file no longer touches sessions at all.
//
// A totem is configuration only: which game it runs (embeddable as an
// iframe), slots, play time, queue cap, and — optionally — the UDP address
// of a physical cabinet. At least one of `game` or `ip` must be set.

import { TotemRepository } from './totem.repository.js'
import { isKnownGame, gameConfigSchema, validateGameConfig } from '../../lib/games.js'
import { queueKey }        from '../../lib/channels.js'
import { env }             from '../../config/env.js'
import { createLogger }    from '../../lib/logger.js'
import { newTotemKey }     from '../../lib/auth.js'

const log = createLogger('totem.service')

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim())

/**
 * Validates/normalizes the fields present in `fields`.
 * @returns {{ ok: true, patch: object } | { ok: false, error: string }}
 */
function validate(fields, { creating }) {
  const patch = {}

  if (fields.name !== undefined || creating) {
    if (blank(fields.name)) return { ok: false, error: 'name is required' }
    patch.name = fields.name.trim()
  }

  if (fields.ip !== undefined || creating) {
    if (blank(fields.ip)) {
      patch.ip = null
      patch.udpPort = null
    } else {
      const port = Number(fields.udpPort)
      if (!port || port < 1 || port > 65535) return { ok: false, error: 'udpPort must be between 1 and 65535' }
      patch.ip = fields.ip.trim()
      patch.udpPort = port
    }
  } else if (fields.udpPort !== undefined && fields.udpPort !== null) {
    const port = Number(fields.udpPort)
    if (port < 1 || port > 65535) return { ok: false, error: 'udpPort must be between 1 and 65535' }
    patch.udpPort = port
  }

  if (fields.game !== undefined || creating) {
    if (blank(fields.game)) patch.game = null
    else if (!isKnownGame(env.gamesDir, fields.game)) return { ok: false, error: `Unknown game: ${fields.game}` }
    else patch.game = fields.game
  }

  if (fields.gameConfig !== undefined) {
    const gc = fields.gameConfig
    if (gc !== null && (typeof gc !== 'object' || Array.isArray(gc))) {
      return { ok: false, error: 'gameConfig must be an object or null' }
    }
    patch.gameConfig = gc
  }

  // Fields the game's config.schema.json knows must be in range.
  const game = patch.game !== undefined ? patch.game : fields.currentGame
  if (patch.gameConfig && game) {
    const problem = validateGameConfig(gameConfigSchema(env.gamesDir, game), patch.gameConfig)
    if (problem) return { ok: false, error: problem }
  }

  if (fields.maxPlayers !== undefined && fields.maxPlayers !== null) {
    const mp = Number(fields.maxPlayers)
    if (mp < 1 || mp > 8) return { ok: false, error: 'maxPlayers must be 1–8' }
    patch.maxPlayers = mp
  }
  if (fields.sessionDurationMs !== undefined && fields.sessionDurationMs !== null) {
    const dur = Number(fields.sessionDurationMs)
    if (dur < 60_000) return { ok: false, error: 'sessionDurationMs must be >= 60000 (1 min)' }
    patch.sessionDurationMs = dur
  }
  if (fields.maxQueueSize !== undefined) {
    if (fields.maxQueueSize === null) {
      patch.maxQueueSize = null
    } else {
      const mqs = Number(fields.maxQueueSize)
      if (mqs < 1 || mqs > 200) return { ok: false, error: 'maxQueueSize must be 1–200' }
      patch.maxQueueSize = mqs
    }
  }

  return { ok: true, patch }
}

export class TotemService {
  /**
   * @param {import('@fastify/mongodb').FastifyMongoObject} mongo
   * @param {import('ioredis').Redis} [redisPublisher]  Only for queueSize in listTotems
   */
  constructor(mongo, redisPublisher) {
    this.repo      = new TotemRepository(mongo)
    this._redisPub = redisPublisher ?? null
  }

  async createTotem(fields) {
    const v = validate(fields ?? {}, { creating: true })
    if (!v.ok) return v
    if (!v.patch.ip && !v.patch.game) return { ok: false, error: 'Set a game (embed) and/or an ip + udpPort (physical totem)' }

    const totem = await this.repo.create({ ...v.patch, gameKey: newTotemKey() })
    log.info({ totemId: totem._id, name: totem.name, game: totem.game }, 'Totem created')
    return { ok: true, totem }
  }

  async listTotems() {
    const totems = await this.repo.list()
    if (this._redisPub) {
      await Promise.all(totems.map(async (t) => {
        t.queueSize = await this._redisPub.llen(queueKey(t._id))
      }))
    }
    return totems
  }

  async findTotem(id) {
    return this.repo.findById(id)
  }

  async updateTotem(id, fields) {
    const exists = await this.repo.findById(id)
    if (!exists) return { ok: false, error: 'Totem not found' }

    const v = validate({ ...(fields ?? {}), currentGame: exists.game }, { creating: false })
    if (!v.ok) return v
    const next = { ...exists, ...v.patch }
    if (!next.ip && !next.game) return { ok: false, error: 'Set a game (embed) and/or an ip + udpPort (physical totem)' }

    await this.repo.update(id, v.patch)
    log.info({ totemId: id }, 'Totem updated')
    return { ok: true }
  }

  async setPaused(id, paused, by = null) {
    const exists = await this.repo.findById(id)
    if (!exists) return { ok: false, error: 'Totem not found' }
    await this.repo.update(id, paused
      ? { paused: true, pausedAt: new Date(), pausedBy: by }
      : { paused: false, pausedAt: null, pausedBy: null })
    return { ok: true }
  }

  /** New key for the game/bridge; the old one stops working immediately. */
  async rotateGameKey(id) {
    const exists = await this.repo.findById(id)
    if (!exists) return { ok: false, error: 'Totem not found' }
    const gameKey = newTotemKey()
    await this.repo.update(id, { gameKey })
    log.info({ totemId: id }, 'Totem key rotated')
    return { ok: true, gameKey }
  }

  async deleteTotem(id) {
    const deleted = await this.repo.delete(id)
    if (!deleted) return { ok: false, error: 'Totem not found' }
    log.info({ totemId: id }, 'Totem deleted')
    return { ok: true }
  }
}
