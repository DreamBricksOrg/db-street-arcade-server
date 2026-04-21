// src/modules/totem/totem.routes.js
// REST API for the /api/totems resource.
//
// Routes:
//   POST   /api/totems              → createTotem
//   GET    /api/totems              → listTotems
//   GET    /api/totems/:id          → getTotem
//   PUT    /api/totems/:id          → updateTotem
//   DELETE /api/totems/:id          → deleteTotem
//   GET    /api/totems/:id/session  → resolveSession (get or create active session)
//   GET    /api/totems/:id/qr       → QR Code PNG for permanent totem entry URL

import fp    from 'fastify-plugin'
import QRCode from 'qrcode'
import { TotemService }  from './totem.service.js'
import { createLogger }  from '../../lib/logger.js'
import { env }           from '../../config/env.js'

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

  const service = new TotemService(fastify.mongo, fastify.redisPublisher)

  // Wire circular dependency: TotemService ↔ SessionService
  // session-routes registers first and decorates fastify.sessionService
  fastify.addHook('onReady', () => {
    if (fastify.sessionService) {
      service.setSessionService(fastify.sessionService)
      fastify.sessionService.setTotemService(service)
      log.info('TotemService ↔ SessionService wired')
    }
  })

  // ── POST /api/totems ─────────────────────────────────────────────────────────
  fastify.post('/api/totems', async (request, reply) => {
    const { name, ip, udpPort, maxPlayers, sessionDurationMs } = request.body ?? {}

    const result = await service.createTotem({
      name,
      ip,
      udpPort:           Number(udpPort),
      maxPlayers:        maxPlayers        ? Number(maxPlayers)        : undefined,
      sessionDurationMs: sessionDurationMs ? Number(sessionDurationMs) : undefined,
    })

    if (!result.ok) return reply.status(400).send({ error: result.error })

    return reply.status(201).send(result.totem)
  })

  // ── GET /api/totems ──────────────────────────────────────────────────────────
  fastify.get('/api/totems', async () => {
    return service.listTotems()
  })

  // ── GET /api/totems/:id ──────────────────────────────────────────────────────
  fastify.get('/api/totems/:id', { schema: { params: totemIdParam } }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    return totem
  })

  // ── PUT /api/totems/:id ──────────────────────────────────────────────────────
  fastify.put('/api/totems/:id', { schema: { params: totemIdParam } }, async (request, reply) => {
    const { name, ip, udpPort, maxPlayers, sessionDurationMs } = request.body ?? {}

    const fields = {}
    if (name              !== undefined) fields.name              = name
    if (ip                !== undefined) fields.ip                = ip
    if (udpPort           !== undefined) fields.udpPort           = Number(udpPort)
    if (maxPlayers        !== undefined) fields.maxPlayers        = Number(maxPlayers)
    if (sessionDurationMs !== undefined) fields.sessionDurationMs = Number(sessionDurationMs)

    const result = await service.updateTotem(request.params.id, fields)

    if (!result.ok) {
      const status = result.error === 'Totem not found' ? 404 : 400
      return reply.status(status).send({ error: result.error })
    }

    return reply.status(204).send()
  })

  // ── DELETE /api/totems/:id ───────────────────────────────────────────────────
  fastify.delete('/api/totems/:id', { schema: { params: totemIdParam } }, async (request, reply) => {
    const result = await service.deleteTotem(request.params.id)
    if (!result.ok) return reply.status(404).send({ error: result.error })
    return reply.status(204).send()
  })

  // ── GET /api/totems/:id/session ──────────────────────────────────────────────
  // Returns the active session for this totem, creating one if needed.
  fastify.get('/api/totems/:id/session', { schema: { params: totemIdParam } }, async (request, reply) => {
    const result = await service.resolveSession(request.params.id)

    if (!result.ok) {
      const status = result.error === 'Totem not found' ? 404 : 500
      return reply.status(status).send({ error: result.error })
    }

    const s       = result.session
    const sid     = s._id ?? s.id
    const playUrl = `${env.publicUrl}/play/${sid}`

    return {
      sessionId:  sid,
      totemId:    s.totemId,
      status:     s.status,
      maxPlayers: s.maxPlayers,
      expiresAt:  s.expiresAt,
      playUrl,
    }
  })

  // ── GET /api/totems/:id/qr ───────────────────────────────────────────────────
  // Returns a permanent QR Code PNG pointing to /play/totem?id=:totemId
  fastify.get('/api/totems/:id/qr', { schema: { params: totemIdParam } }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    const entryUrl = `${env.publicUrl}/play/totem?id=${request.params.id}`
    const format   = request.query.format ?? 'png'

    if (format === 'dataurl') {
      const dataUrl = await QRCode.toDataURL(entryUrl, { width: 300, margin: 2 })
      return { totemId: request.params.id, entryUrl, qr: dataUrl }
    }

    const buffer = await QRCode.toBuffer(entryUrl, { type: 'png', width: 300, margin: 2 })
    reply.header('Content-Type', 'image/png')
    reply.header('Cache-Control', 'public, max-age=3600') // QR is permanent — cache 1h
    return reply.send(buffer)
  })
}

export default fp(totemRoutes, {
  name:         'totem-routes',
  dependencies: ['mongodb'],
})
