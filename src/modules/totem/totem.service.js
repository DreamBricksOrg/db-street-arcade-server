// src/modules/totem/totem.service.js
// CRUD-only business logic for totems. The queue/session lifecycle lives in
// totemQueue.service.js — this file no longer touches sessions at all.

import { TotemRepository } from './totem.repository.js'
import { createLogger }    from '../../lib/logger.js'

const log = createLogger('totem.service')

export class TotemService {
  /**
   * @param {import('@fastify/mongodb').FastifyMongoObject} mongo
   * @param {import('ioredis').Redis} [redisPublisher]  Only for queueSize in listTotems
   */
  constructor(mongo, redisPublisher) {
    this.repo      = new TotemRepository(mongo)
    this._redisPub = redisPublisher ?? null
  }

  async createTotem({ name, ip, udpPort, maxPlayers, sessionDurationMs, maxQueueSize }) {
    if (!name?.trim()) return { ok: false, error: 'name is required' }
    if (!ip?.trim())   return { ok: false, error: 'ip is required' }
    if (!udpPort || udpPort < 1 || udpPort > 65535)
      return { ok: false, error: 'udpPort must be between 1 and 65535' }

    const mp  = maxPlayers        ? Number(maxPlayers)        : undefined
    const dur = sessionDurationMs ? Number(sessionDurationMs) : undefined
    const mqs = maxQueueSize      ? Number(maxQueueSize)      : undefined

    if (mp  !== undefined && (mp < 1 || mp > 8))     return { ok: false, error: 'maxPlayers must be 1–8' }
    if (dur !== undefined && dur < 60_000)           return { ok: false, error: 'sessionDurationMs must be >= 60000 (1 min)' }
    if (mqs !== undefined && (mqs < 1 || mqs > 200)) return { ok: false, error: 'maxQueueSize must be 1–200' }

    const totem = await this.repo.create({
      name: name.trim(), ip: ip.trim(), udpPort,
      maxPlayers: mp, sessionDurationMs: dur, maxQueueSize: mqs,
    })
    log.info({ totemId: totem._id, name: totem.name }, 'Totem created')
    return { ok: true, totem }
  }

  async listTotems() {
    const totems = await this.repo.list()
    if (this._redisPub) {
      await Promise.all(totems.map(async (t) => {
        t.queueSize = await this._redisPub.llen(`queue:totem:${t._id}`)
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

    const patch = {}
    if (fields.name    !== undefined) patch.name = fields.name.trim()
    if (fields.ip      !== undefined) patch.ip   = fields.ip.trim()
    if (fields.udpPort !== undefined) {
      const port = Number(fields.udpPort)
      if (port < 1 || port > 65535) return { ok: false, error: 'udpPort must be between 1 and 65535' }
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
    if (fields.maxQueueSize !== undefined) {
      if (fields.maxQueueSize === null) {
        patch.maxQueueSize = null
      } else {
        const mqs = Number(fields.maxQueueSize)
        if (mqs < 1 || mqs > 200) return { ok: false, error: 'maxQueueSize must be 1–200' }
        patch.maxQueueSize = mqs
      }
    }

    await this.repo.update(id, patch)
    log.info({ totemId: id }, 'Totem updated')
    return { ok: true }
  }

  async deleteTotem(id) {
    const deleted = await this.repo.delete(id)
    if (!deleted) return { ok: false, error: 'Totem not found' }
    log.info({ totemId: id }, 'Totem deleted')
    return { ok: true }
  }
}
