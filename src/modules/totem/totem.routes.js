// src/modules/totem/totem.routes.js
// REST CRUD for the /api/totems resource.
//
// Routes:
//   POST   /api/totems         → createTotem
//   GET    /api/totems         → listTotems
//   GET    /api/totems/:id     → getTotem
//   PUT    /api/totems/:id     → updateTotem
//   DELETE /api/totems/:id     → deleteTotem

import fp           from 'fastify-plugin'
import { TotemService } from './totem.service.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('totem.routes')

const totemIdParam = {
  type:       'object',
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
  required:   ['id'],
}

async function totemRoutes(fastify) {
  if (!fastify.mongo) {
    log.warn('MongoDB not available — totem routes disabled')
    return
  }

  const service = new TotemService(fastify.mongo)

  // ── POST /api/totems ────────────────────────────────────────────────────────
  fastify.post('/api/totems', async (request, reply) => {
    const { name, ip, udpPort } = request.body ?? {}

    const result = await service.createTotem({ name, ip, udpPort: Number(udpPort) })

    if (!result.ok) return reply.status(400).send({ error: result.error })

    return reply.status(201).send(result.totem)
  })

  // ── GET /api/totems ─────────────────────────────────────────────────────────
  fastify.get('/api/totems', async () => {
    return service.listTotems()
  })

  // ── GET /api/totems/:id ─────────────────────────────────────────────────────
  fastify.get('/api/totems/:id', { schema: { params: totemIdParam } }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    return totem
  })

  // ── PUT /api/totems/:id ─────────────────────────────────────────────────────
  fastify.put('/api/totems/:id', { schema: { params: totemIdParam } }, async (request, reply) => {
    const { name, ip, udpPort } = request.body ?? {}

    const fields = {}
    if (name    !== undefined) fields.name    = name
    if (ip      !== undefined) fields.ip      = ip
    if (udpPort !== undefined) fields.udpPort = Number(udpPort)

    const result = await service.updateTotem(request.params.id, fields)

    if (!result.ok) {
      const status = result.error === 'Totem not found' ? 404 : 400
      return reply.status(status).send({ error: result.error })
    }

    return reply.status(204).send()
  })

  // ── DELETE /api/totems/:id ──────────────────────────────────────────────────
  fastify.delete('/api/totems/:id', { schema: { params: totemIdParam } }, async (request, reply) => {
    const result = await service.deleteTotem(request.params.id)
    if (!result.ok) return reply.status(404).send({ error: result.error })
    return reply.status(204).send()
  })
}

export default fp(totemRoutes, {
  name:         'totem-routes',
  dependencies: ['mongodb'],
})
