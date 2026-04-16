// src/modules/totem/totem.service.js
// Business logic layer for totems.
// Validates input and delegates to the repository.

import { TotemRepository } from './totem.repository.js'
import { createLogger }    from '../../lib/logger.js'

const log = createLogger('totem.service')

export class TotemService {
  /** @param {import('@fastify/mongodb').FastifyMongoObject} mongo */
  constructor(mongo) {
    this.repo = new TotemRepository(mongo)
  }

  /**
   * Creates a new totem after validating fields.
   * @param {{ name: string, ip: string, udpPort: number }} data
   * @returns {Promise<{ ok: true, totem: object } | { ok: false, error: string }>}
   */
  async createTotem({ name, ip, udpPort }) {
    if (!name?.trim()) return { ok: false, error: 'name is required' }
    if (!ip?.trim())   return { ok: false, error: 'ip is required' }
    if (!udpPort || udpPort < 1 || udpPort > 65535)
      return { ok: false, error: 'udpPort must be between 1 and 65535' }

    const totem = await this.repo.create({ name: name.trim(), ip: ip.trim(), udpPort })
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
   * @param {{ name?: string, ip?: string, udpPort?: number }} fields
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async updateTotem(id, fields) {
    const exists = await this.repo.findById(id)
    if (!exists) return { ok: false, error: 'Totem not found' }

    const patch = {}
    if (fields.name !== undefined) patch.name = fields.name.trim()
    if (fields.ip   !== undefined) patch.ip   = fields.ip.trim()
    if (fields.udpPort !== undefined) {
      const port = Number(fields.udpPort)
      if (port < 1 || port > 65535)
        return { ok: false, error: 'udpPort must be between 1 and 65535' }
      patch.udpPort = port
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
}
