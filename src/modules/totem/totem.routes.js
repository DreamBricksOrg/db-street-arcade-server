// src/modules/totem/totem.routes.js
// REST API for /api/totems: CRUD + queue endpoints (backed by TotemQueueService).
//
// Queue model: one session per player. A totem with maxPlayers=N holds up to
// N live sessions; the waiting list advances one player per freed slot.

import fp     from 'fastify-plugin'
import QRCode from 'qrcode'
import { TotemService }      from './totem.service.js'
import { TotemQueueService } from './totemQueue.service.js'
import { createLogger }      from '../../lib/logger.js'
import { env }               from '../../config/env.js'
import { createRateLimiter } from '../../lib/rateLimit.js'

const log = createLogger('totem.routes')

// Generous enough for legit retries/reconnects, tight enough to stop a spam loop.
const queueJoinRateLimit = createRateLimiter({ windowMs: 10_000, max: env.queueJoinRateMax })

const totemIdParam = {
  type:       'object',
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
  required:   ['id'],
}

const totemBodyProps = {
  name:              { type: 'string' },
  ip:                { type: 'string' },
  udpPort:           { type: 'number' },
  maxPlayers:        { type: 'number' },
  sessionDurationMs: { type: 'number' },
  maxQueueSize:      { type: 'number', nullable: true },
}

const totemResponseProps = {
  _id:               { type: 'string' },
  name:              { type: 'string' },
  ip:                { type: 'string' },
  udpPort:           { type: 'number' },
  maxPlayers:        { type: 'number', nullable: true },
  sessionDurationMs: { type: 'number', nullable: true },
  maxQueueSize:      { type: 'number', nullable: true },
  queueSize:         { type: 'number' },
}

const errorResponse = { type: 'object', properties: { error: { type: 'string' } } }

async function totemRoutes(fastify) {
  if (!fastify.mongo) {
    log.warn('MongoDB not available — totem routes disabled')
    return
  }

  const service = new TotemService(fastify.mongo, fastify.redisPublisher)
  const queue   = new TotemQueueService(fastify, service)
  fastify.decorate('totemQueue', queue)

  // Sweeper: expires no_show reservations and timed-out actives.
  const sweepTimer = setInterval(() => {
    queue.sweep().catch(err => log.error({ err: err.message }, 'Sweep failed'))
  }, env.queueSweepMs)
  fastify.addHook('onClose', () => clearInterval(sweepTimer))
  log.info({ sweepMs: env.queueSweepMs, reserveMs: env.queueReserveMs }, 'Queue sweeper started')

  // ── Queue SSE hub ──────────────────────────────────────────────────────────
  // Waiting players get pushed a "something changed" ping so they re-check
  // their status immediately instead of waiting for the next poll tick.
  const queueSseClients = new Map() // totemId → Set<res>

  if (fastify.redisSubscriber) {
    fastify.redisSubscriber.psubscribe('queue:event:*').catch(err =>
      log.error({ err: err.message }, 'Failed to subscribe to queue events'))
    fastify.redisSubscriber.on('pmessage', (pattern, channel) => {
      if (pattern !== 'queue:event:*') return
      const totemId = channel.slice('queue:event:'.length)
      const clients = queueSseClients.get(totemId)
      if (!clients) return
      for (const res of clients) {
        try { res.write('data: {"type":"queue_changed"}\n\n') } catch { /* gone */ }
      }
    })
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  fastify.post('/api/totems', {
    schema: {
      tags: ['Totems'], summary: 'Create a new totem',
      body: { type: 'object', properties: totemBodyProps, required: ['name', 'ip', 'udpPort'] },
      response: {
        201: { type: 'object', properties: totemResponseProps },
        400: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { name, ip, udpPort, maxPlayers, sessionDurationMs, maxQueueSize } = request.body ?? {}
    const result = await service.createTotem({ name, ip, udpPort: Number(udpPort), maxPlayers, sessionDurationMs, maxQueueSize })
    if (!result.ok) return reply.status(400).send({ error: result.error })
    return reply.status(201).send(result.totem)
  })

  fastify.get('/api/totems', {
    schema: {
      tags: ['Totems'], summary: 'List all totems',
      response: { 200: { type: 'array', items: { type: 'object', properties: totemResponseProps } } },
    },
  }, async () => service.listTotems())

  fastify.get('/api/totems/:id', {
    schema: {
      tags: ['Totems'], summary: 'Get a totem by ID', params: totemIdParam,
      response: { 200: { type: 'object', properties: totemResponseProps }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    return totem
  })

  fastify.put('/api/totems/:id', {
    schema: {
      tags: ['Totems'], summary: 'Update a totem', params: totemIdParam,
      body: { type: 'object', properties: totemBodyProps },
      response: { 204: { type: 'null' }, 400: errorResponse, 404: errorResponse },
    },
  }, async (request, reply) => {
    const result = await service.updateTotem(request.params.id, request.body ?? {})
    if (!result.ok) {
      return reply.status(result.error === 'Totem not found' ? 404 : 400).send({ error: result.error })
    }
    return reply.status(204).send()
  })

  fastify.delete('/api/totems/:id', {
    schema: {
      tags: ['Totems'], summary: 'Delete a totem', params: totemIdParam,
      response: { 204: { type: 'null' }, 404: errorResponse },
    },
  }, async (request, reply) => {
    await queue.endAllForTotem(request.params.id, 'manual')
    await queue.clearQueue(request.params.id)
    const result = await service.deleteTotem(request.params.id)
    if (!result.ok) return reply.status(404).send({ error: result.error })
    return reply.status(204).send()
  })

  // ── Queue ──────────────────────────────────────────────────────────────────

  fastify.post('/api/totems/:id/queue/join', {
    preHandler: queueJoinRateLimit,
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Join totem: get own session or wait in line',
      params: totemIdParam,
      body: {
        type: 'object',
        properties: { playerId: { type: 'string' }, metadata: { type: 'object', additionalProperties: true } },
        required: ['playerId'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            status:          { type: 'string', enum: ['play', 'queue'] },
            sessionId:       { type: 'string' },
            position:        { type: 'number' },
            estimatedWaitMs: { type: 'number', nullable: true },
          },
        },
        404: errorResponse, 409: errorResponse, 429: errorResponse, 500: errorResponse, 503: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { playerId, metadata: clientMeta } = request.body
    const metadata = { ua: request.headers['user-agent'], ip: request.ip, ...(clientMeta || {}) }
    const result = await queue.join(request.params.id, playerId, metadata)
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    return result
  })

  fastify.get('/api/totems/:id/queue/status', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Player queue status (play | queue position)',
      params: totemIdParam,
      querystring: { type: 'object', properties: { playerId: { type: 'string' } }, required: ['playerId'] },
      response: {
        200: {
          type: 'object',
          properties: {
            status:          { type: 'string', enum: ['play', 'queue'] },
            sessionId:       { type: 'string' },
            position:        { type: 'number' },
            size:            { type: 'number' },
            estimatedWaitMs: { type: 'number', nullable: true },
          },
        },
        404: errorResponse, 500: errorResponse,
      },
    },
  }, async (request, reply) => {
    const result = await queue.status(request.params.id, request.query.playerId)
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    return result
  })

  fastify.get('/api/totems/:id/queue', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Operator view: live sessions + waiting list',
      params: totemIdParam,
      response: {
        200: {
          type: 'object',
          properties: {
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string' },
                  playerId:  { type: 'string' },
                  status:    { type: 'string' },
                  metadata:  { type: 'object', additionalProperties: true, nullable: true },
                  createdAt: { type: 'string' },
                  expiresAt: { type: 'string' },
                },
              },
            },
            queue: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id:              { type: 'string' },
                  metadata:        { type: 'object', additionalProperties: true, nullable: true },
                  heartbeatTtl:    { type: 'number', nullable: true },
                  estimatedWaitMs: { type: 'number', nullable: true },
                },
              },
            },
            maxPlayers:   { type: 'number' },
            maxQueueSize: { type: 'number', nullable: true },
          },
        },
        404: errorResponse,
      },
    },
  }, async (request, reply) => {
    const result = await queue.operatorView(request.params.id)
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    const { ok, ...view } = result
    return view
  })

  fastify.get('/api/totems/:id/queue/events', {
    schema: { tags: ['Totems', 'Queue'], summary: 'SSE stream of queue change pings', params: totemIdParam },
  }, async (request, reply) => {
    const { id } = request.params
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    reply.raw.write('data: {"type":"connected"}\n\n')

    if (!queueSseClients.has(id)) queueSseClients.set(id, new Set())
    queueSseClients.get(id).add(reply.raw)

    const heartbeat = setInterval(() => {
      try { reply.raw.write(': ping\n\n') } catch { /* gone */ }
    }, 20_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      queueSseClients.get(id)?.delete(reply.raw)
    })
  })

  fastify.delete('/api/totems/:id/queue/:playerId', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Remove a player from the waiting list',
      params: {
        type: 'object',
        properties: {
          id:       { type: 'string', minLength: 36, maxLength: 36 },
          playerId: { type: 'string', minLength: 1 },
        },
        required: ['id', 'playerId'],
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    await queue.kickFromQueue(request.params.id, request.params.playerId)
    log.info({ totemId: request.params.id, playerId: request.params.playerId }, 'Player kicked from queue')
    return { ok: true }
  })

  fastify.post('/api/totems/:id/queue/clear', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Clear the waiting list (live sessions untouched)',
      params: totemIdParam,
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    await queue.clearQueue(request.params.id)
    return { ok: true }
  })

  // ── Game integration ───────────────────────────────────────────────────────
  // With playerId (from the game, possibly truncated to 8 chars): ends only
  // that player's session. Without: ends every session of the totem (reset).
  fastify.post('/api/totems/:id/end-session', {
    schema: {
      tags: ['Totems'], summary: "End one player's session (game death) or all sessions (reset)",
      params: totemIdParam,
      body: { type: 'object', properties: { playerId: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            ok:             { type: 'boolean' },
            endedSessionId: { type: 'string', nullable: true },
            endedCount:     { type: 'number', nullable: true },
          },
        },
        404: errorResponse, 500: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const totem = await service.findTotem(id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    const { playerId } = request.body || {}
    if (playerId) {
      const session = await queue.findCurrentByPidPrefix(id, playerId)
      if (!session) return reply.status(404).send({ error: 'No live session for this player' })
      const result = await queue.endSession(session._id, 'died')
      if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
      log.info({ totemId: id, playerId, sessionId: session._id }, 'Player died — session ended')
      return { ok: true, endedSessionId: session._id }
    }

    const result = await queue.endAllForTotem(id, 'manual')
    log.info({ totemId: id, endedCount: result.endedCount }, 'All sessions ended (operator reset)')
    return { ok: true, endedCount: result.endedCount }
  })

  // ── QR ─────────────────────────────────────────────────────────────────────
  fastify.get('/api/totems/:id/qr', {
    schema: {
      tags: ['Totems'], summary: 'Get totem QR code', params: totemIdParam,
      querystring: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'dataurl'] } } },
      response: { 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    const entryUrl = `${env.publicUrl}/play/totem?id=${request.params.id}`
    if ((request.query.format ?? 'png') === 'dataurl') {
      const dataUrl = await QRCode.toDataURL(entryUrl, { width: 300, margin: 2 })
      return { totemId: request.params.id, entryUrl, qr: dataUrl }
    }
    const buffer = await QRCode.toBuffer(entryUrl, { type: 'png', width: 300, margin: 2 })
    reply.header('Content-Type', 'image/png')
    reply.header('Cache-Control', 'public, max-age=3600')
    return reply.send(buffer)
  })
}

export default fp(totemRoutes, {
  name: 'totem-routes',
  // No declared `dependencies: ['mongodb']` on purpose: that would make
  // Fastify hard-assert the mongodb plugin was registered and crash if not,
  // bypassing the graceful `if (!fastify.mongo) return` guard above that's
  // meant to handle Mongo being down in development.
})
