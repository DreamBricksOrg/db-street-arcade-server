// src/modules/session/session.routes.js
// Read/end operations on per-player sessions. Sessions are CREATED only by
// TotemQueueService (queue/join) — there is no create route anymore.
// Ending goes through fastify.totemQueue so the freed slot advances the queue.

import fp     from 'fastify-plugin'
import QRCode from 'qrcode'
import { SessionRepository } from './session.repository.js'
import { createLogger }      from '../../lib/logger.js'
import { env }               from '../../config/env.js'

const log = createLogger('session.routes')

const sessionIdParam = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
  required: ['id'],
}

const errorResponse = { type: 'object', properties: { error: { type: 'string' } } }

const sessionShape = {
  type: 'object',
  properties: {
    sessionId: { type: 'string' },
    totemId:   { type: 'string', nullable: true },
    playerId:  { type: 'string' },
    status:    { type: 'string' },
    createdAt: { type: 'string' },
    expiresAt: { type: 'string' },
    endedAt:   { type: 'string', nullable: true },
    endReason: { type: 'string', nullable: true },
  },
}

function toDto(s) {
  return {
    sessionId: s._id,
    totemId:   s.totemId ?? null,
    playerId:  s.playerId,
    status:    s.status,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    endedAt:   s.endedAt ?? null,
    endReason: s.endReason ?? null,
  }
}

async function sessionRoutes(fastify) {
  if (!fastify.mongo) {
    log.warn('MongoDB not available — session routes disabled')
    return
  }

  const repo = new SessionRepository(fastify.mongo)

  fastify.get('/api/sessions', {
    schema: {
      tags: ['Sessions'], summary: 'List live (reserved/active) sessions',
      response: { 200: { type: 'array', items: sessionShape } },
    },
  }, async () => {
    const sessions = await repo.listCurrentAll()
    return sessions.map(toDto)
  })

  fastify.get('/api/sessions/:id', {
    schema: {
      tags: ['Sessions'], summary: 'Get a session by ID', params: sessionIdParam,
      response: { 200: sessionShape, 404: errorResponse },
    },
  }, async (request, reply) => {
    const session = await repo.findById(request.params.id)
    if (!session) return reply.status(404).send({ error: 'Session not found' })
    return toDto(session)
  })

  fastify.post('/api/sessions/:id/end', {
    schema: {
      tags: ['Sessions'], summary: "End a player's session (frees the slot, queue advances)",
      params: sessionIdParam,
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const result = await fastify.totemQueue.endSession(request.params.id, 'manual')
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    return { ok: true }
  })

  // Kept for URL compatibility with the dashboard — same effect as /end.
  fastify.post('/api/sessions/:id/players/:playerId/kick', {
    schema: {
      tags: ['Sessions'], summary: 'Kick the player (ends their session, queue advances)',
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, playerId: { type: 'string' } },
        required: ['id', 'playerId'],
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const result = await fastify.totemQueue.endSession(request.params.id, 'kicked')
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    return { ok: true }
  })

  fastify.delete('/api/sessions/:id', {
    schema: {
      tags: ['Sessions'], summary: 'Hard delete a session (admin)', params: sessionIdParam,
      response: { 204: { type: 'null' }, 404: errorResponse },
    },
  }, async (request, reply) => {
    await fastify.totemQueue.endSession(request.params.id, 'manual').catch(() => {})
    const deleted = await repo.delete(request.params.id)
    if (!deleted) return reply.status(404).send({ error: 'Session not found' })
    return reply.status(204).send()
  })

  fastify.get('/api/sessions/:id/qr', {
    schema: {
      tags: ['Sessions'], summary: 'QR code for the play page', params: sessionIdParam,
      querystring: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'dataurl'] } } },
      response: { 404: errorResponse },
    },
  }, async (request, reply) => {
    const session = await repo.findById(request.params.id)
    if (!session) return reply.status(404).send({ error: 'Session not found' })

    const playUrl = `${env.publicUrl}/play/${request.params.id}`
    if ((request.query.format ?? 'png') === 'dataurl') {
      return { sessionId: request.params.id, playUrl, qr: await QRCode.toDataURL(playUrl, { width: 300, margin: 2 }) }
    }
    const buffer = await QRCode.toBuffer(playUrl, { type: 'png', width: 300, margin: 2 })
    reply.header('Content-Type', 'image/png')
    return reply.send(buffer)
  })
}

export default fp(sessionRoutes, {
  name: 'session-routes',
  // No declared `dependencies: ['mongodb']` on purpose: that would make
  // Fastify hard-assert the mongodb plugin was registered and crash if not,
  // bypassing the graceful `if (!fastify.mongo) return` guard above that's
  // meant to handle Mongo being down in development.
})
