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
   * @returns {Promise<object[]>}
   */
  async listTotems() {
    return this.repo.list()
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
   * Uses totem's maxPlayers and sessionDurationMs, falling back to env defaults.
   *
   * @param {object} totem  Full totem document
   * @returns {Promise<{ ok: true, session: object } | { ok: false, error: string }>}
   */
  async startNewSession(totem) {
    const svc = this._getSessionService()

    const session = await svc.createSession({
      totemId:    totem._id,
      totems:     [{ id: totem._id, ip: totem.ip, udpPort: totem.udpPort }],
      maxPlayers: totem.maxPlayers ?? env.sessionMaxPlayers,
      ttlMs:      totem.sessionDurationMs ?? env.sessionTimeoutMs,
    })

    await this.repo.setCurrentSession(totem._id, session._id)
    log.info({ totemId: totem._id, sessionId: session._id }, 'New session started for totem')
    return { ok: true, session }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _getSessionService() {
    if (!this._SessionService) {
      throw new Error('SessionService not injected into TotemService — call setSessionService()')
    }
    return this._SessionService
  }
}
