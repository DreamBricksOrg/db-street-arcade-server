// src/modules/totem/totem.service.js
// Business logic layer for totems.
// Owns the totem session lifecycle: resolve, start, and rotate sessions.

import { TotemRepository } from './totem.repository.js'
import { createLogger }    from '../../lib/logger.js'
import { env }             from '../../config/env.js'

const log = createLogger('totem.service')

export class TotemService {
  /**
   * @param {import('@fastify/mongodb').FastifyMongoObject} mongo
   * @param {import('ioredis').Redis} [redisPublisher]
   */
  constructor(mongo, redisPublisher) {
    this.repo          = new TotemRepository(mongo)
    this._mongo        = mongo
    this._redisPub     = redisPublisher
    // Lazily imported to avoid circular dependency
    this._SessionService = null
  }

  // ── Session wiring ──────────────────────────────────────────────────────────

  /**
   * Injects the SessionService after construction (avoids circular import).
   * Called from totem.routes.js which has both services available.
   * @param {import('../session/session.service.js').SessionService} sessionService
   */
  setSessionService(sessionService) {
    this._SessionService = sessionService
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  /**
   * Creates a new totem after validating fields.
   * @param {{ name: string, ip: string, udpPort: number, maxPlayers?: number, sessionDurationMs?: number }} data
   * @returns {Promise<{ ok: true, totem: object } | { ok: false, error: string }>}
   */
  async createTotem({ name, ip, udpPort, maxPlayers, sessionDurationMs }) {
    if (!name?.trim()) return { ok: false, error: 'name is required' }
    if (!ip?.trim())   return { ok: false, error: 'ip is required' }
    if (!udpPort || udpPort < 1 || udpPort > 65535)
      return { ok: false, error: 'udpPort must be between 1 and 65535' }

    const mp  = maxPlayers        ? Number(maxPlayers)        : undefined
    const dur = sessionDurationMs ? Number(sessionDurationMs) : undefined

    if (mp  !== undefined && (mp  < 1 || mp  > 8))   return { ok: false, error: 'maxPlayers must be 1–8' }
    if (dur !== undefined && (dur < 60_000))           return { ok: false, error: 'sessionDurationMs must be >= 60000 (1 min)' }

    const totem = await this.repo.create({
      name: name.trim(),
      ip:   ip.trim(),
      udpPort,
      maxPlayers:        mp,
      sessionDurationMs: dur,
    })

    log.info({ totemId: totem._id, name: totem.name }, 'Totem created')
    return { ok: true, totem }
  }

  /**
   * Returns all totems.
   * Includes the current queue size for each.
   * @returns {Promise<object[]>}
   */
  async listTotems() {
    const totems = await this.repo.list()
    
    if (this._redisPub) {
      await Promise.all(totems.map(async (t) => {
        t.queueSize = await this._redisPub.llen(`queue:totem:${t._id}`)
      }))
    }

    return totems
  }

  /**
   * Finds a single totem by ID.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async findTotem(id) {
    return this.repo.findById(id)
  }

  /**
   * Updates a totem's fields. Only provided fields are changed.
   * @param {string} id
   * @param {{ name?: string, ip?: string, udpPort?: number, maxPlayers?: number, sessionDurationMs?: number }} fields
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async updateTotem(id, fields) {
    const exists = await this.repo.findById(id)
    if (!exists) return { ok: false, error: 'Totem not found' }

    const patch = {}
    if (fields.name    !== undefined) patch.name    = fields.name.trim()
    if (fields.ip      !== undefined) patch.ip      = fields.ip.trim()
    if (fields.udpPort !== undefined) {
      const port = Number(fields.udpPort)
      if (port < 1 || port > 65535)
        return { ok: false, error: 'udpPort must be between 1 and 65535' }
      patch.udpPort = port
    }
    if (fields.maxPlayers !== undefined) {
      const mp = Number(fields.maxPlayers)
      if (mp < 1 || mp > 8) return { ok: false, error: 'maxPlayers must be 1–8' }
      patch.maxPlayers = mp
    }
    if (fields.sessionDurationMs !== undefined) {
      const dur = Number(fields.sessionDurationMs)
      if (dur < 60_000) return { ok: false, error: 'sessionDurationMs must be >= 60000' }
      patch.sessionDurationMs = dur
    }

    await this.repo.update(id, patch)
    log.info({ totemId: id }, 'Totem updated')
    return { ok: true }
  }

  /**
   * Permanently removes a totem.
   * @param {string} id
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async deleteTotem(id) {
    const deleted = await this.repo.delete(id)
    if (!deleted) return { ok: false, error: 'Totem not found' }
    log.info({ totemId: id }, 'Totem deleted')
    return { ok: true }
  }

  // ── Session Lifecycle ───────────────────────────────────────────────────────

  /**
   * Resolves the active session for a totem.
   * If no active session exists, automatically creates a new one.
   *
   * @param {string} totemId
   * @returns {Promise<{ ok: true, session: object } | { ok: false, error: string }>}
   */
  async resolveSession(totemId) {
    const totem = await this.repo.findById(totemId)
    if (!totem) return { ok: false, error: 'Totem not found' }

    // Check if there is an existing active session
    if (totem.currentSessionId) {
      const svc     = this._getSessionService()
      const session = await svc.findSession(totem.currentSessionId)

      if (session && session.status !== 'finished') {
        return { ok: true, session }
      }
    }

    // No valid session — start a new one
    return this.startNewSession(totem)
  }

  /**
   * Creates a new session for the given totem and sets it as current.
   * Pops players from the queue to reserve their spots.
   * Uses totem's maxPlayers and sessionDurationMs, falling back to env defaults.
   *
   * @param {object} totem  Full totem document
   * @returns {Promise<{ ok: true, session: object } | { ok: false, error: string }>}
   */
  async startNewSession(totem) {
    const svc = this._getSessionService()

    const maxPlayers = totem.maxPlayers ?? env.sessionMaxPlayers
    const allowedPlayers = await this.dequeuePlayers(totem._id.toString(), maxPlayers)

    const session = await svc.createSession({
      totemId:        totem._id,
      totems:         [{ id: totem._id, ip: totem.ip, udpPort: totem.udpPort }],
      maxPlayers:     maxPlayers,
      ttlMs:          totem.sessionDurationMs ?? env.sessionTimeoutMs,
      allowedPlayers: allowedPlayers,
    })

    await this.repo.setCurrentSession(totem._id, session._id)
    log.info({ totemId: totem._id, sessionId: session._id, allowedPlayers }, 'New session started for totem')
    return { ok: true, session }
  }

  // ── Queue System ────────────────────────────────────────────────────────────

  /**
   * Adds a player to the queue for this totem.
   * Uses Redis List. Also registers a heartbeat for 2 minutes.
   */
  async joinQueue(totemId, playerId, metadata = null) {
    if (!this._redisPub) return { ok: false, error: 'Redis disabled' }
    const qKey = `queue:totem:${totemId}`
    const hKey = `queue:heartbeat:${playerId}`
    const mKey = `player:metadata:${playerId}`
    
    // Check if player is already in queue
    const pos = await this._redisPub.lpos(qKey, playerId)
    // Add heartbeat regardless
    await this._redisPub.setex(hKey, 120, '1')

    // Store metadata if provided (expires with heartbeat)
    if (metadata) {
      await this._redisPub.setex(mKey, 120, JSON.stringify(metadata))
    }

    if (pos !== null) {
      // Already in queue
      return { ok: true, position: pos + 1 }
    }

    // New to queue
    await this._redisPub.rpush(qKey, playerId)
    const len = await this._redisPub.llen(qKey)
    return { ok: true, position: len }
  }

  /**
   * Fetches metadata for a player from Redis.
   */
  async getPlayerMetadata(playerId) {
    if (!this._redisPub) return null
    const mKey = `player:metadata:${playerId}`
    const data = await this._redisPub.get(mKey)
    try {
      return data ? JSON.parse(data) : null
    } catch {
      return null
    }
  }

  /**
   * Returns current queue status for the given player.
   * Refreshes heartbeat.
   */
  async getQueueStatus(totemId, playerId) {
    if (!this._redisPub) return { ok: false, error: 'Redis disabled' }
    const qKey = `queue:totem:${totemId}`
    const hKey = `queue:heartbeat:${playerId}`

    const pos = await this._redisPub.lpos(qKey, playerId)
    if (pos === null) return { ok: false, error: 'Not in queue' }

    // Refresh heartbeat
    await this._redisPub.setex(hKey, 120, '1')
    
    const size = await this._redisPub.llen(qKey)
    return { ok: true, position: pos + 1, size }
  }

  /**
   * Leaves the queue physically.
   */
  async leaveQueue(totemId, playerId) {
    if (!this._redisPub) return { ok: true }
    const qKey = `queue:totem:${totemId}`
    const hKey = `queue:heartbeat:${playerId}`

    await this._redisPub.lrem(qKey, 0, playerId)
    await this._redisPub.del(hKey)
    return { ok: true }
  }

  /**
   * Drops all queue items. (For operator dashboard)
   */
  async clearQueue(totemId) {
    if (!this._redisPub) return { ok: true }
    await this._redisPub.del(`queue:totem:${totemId}`)
    log.info({ totemId }, 'Queue cleared')
    return { ok: true }
  }

  /**
   * Returns how many players are currently waiting in this totem's queue.
   * @param {string} totemId
   * @returns {Promise<number>}
   */
  async getQueueSize(totemId) {
    if (!this._redisPub) return 0
    return this._redisPub.llen(`queue:totem:${totemId}`)
  }

  /**
   * Takes the next 'count' players from the queue, ignoring ghost timeouts.
   * @returns {Promise<string[]>} Array of playerIds
   */
  async dequeuePlayers(totemId, count) {
    if (!this._redisPub) return []
    const qKey = `queue:totem:${totemId}`

    const selected = []
    while (selected.length < count) {
      const playerId = await this._redisPub.lpop(qKey)
      if (!playerId) break // queue is empty

      // Verify heartbeat
      const hKey = `queue:heartbeat:${playerId}`
      const hb = await this._redisPub.get(hKey)
      if (!hb) {
        // Heartbeat expired, ignore this player and continue
        log.info({ totemId, playerId }, 'Queue player expired (no heartbeat)')
        continue
      }
      
      // Clean heartbeat
      await this._redisPub.del(hKey)
      selected.push(playerId)
    }

    return selected
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _getSessionService() {
    if (!this._SessionService) {
      throw new Error('SessionService not injected into TotemService — call setSessionService()')
    }
    return this._SessionService
  }
}
