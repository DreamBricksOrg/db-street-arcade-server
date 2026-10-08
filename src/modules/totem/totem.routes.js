// src/modules/totem/totem.routes.js
// REST API for /api/totems: CRUD + queue endpoints (backed by TotemQueueService).
//
// Queue model: one session per player, per INSTANCE. Instance 'default' is
// the physical totem; `?instance=<id>` targets an embedded iframe (see
// src/modules/embed). An instance with maxPlayers=N holds up to N live
// sessions; its waiting list advances one player per freed slot.

import fp     from 'fastify-plugin'
import QRCode from 'qrcode'
import { TotemService }      from './totem.service.js'
import { TotemQueueService } from './totemQueue.service.js'
import { createLogger }      from '../../lib/logger.js'
import { env }               from '../../config/env.js'
import { createRateLimiter } from '../../lib/rateLimit.js'
import { listGames }         from '../../lib/games.js'
import { computeStats, RANGES } from '../../lib/stats.js'
import { SessionRepository } from '../session/session.repository.js'
import { instanceKey, normalizeInstance, isDefaultInstance } from '../../lib/channels.js'

const log = createLogger('totem.routes')

const totemIdParam = {
  type:       'object',
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
  required:   ['id'],
}

const instanceProp = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }
const instanceQuery = { type: 'object', properties: { instance: instanceProp } }

const totemBodyProps = {
  name:              { type: 'string' },
  ip:                { type: 'string', nullable: true },
  udpPort:           { type: 'number', nullable: true },
  game:              { type: 'string', nullable: true },
  gameConfig:        { type: 'object', nullable: true, additionalProperties: true },
  maxPlayers:        { type: 'number' },
  sessionDurationMs: { type: 'number' },
  maxQueueSize:      { type: 'number', nullable: true },
}

const totemResponseProps = {
  _id:               { type: 'string' },
  name:              { type: 'string' },
  ip:                { type: 'string', nullable: true },
  udpPort:           { type: 'number', nullable: true },
  game:              { type: 'string', nullable: true },
  gameConfig:        { type: 'object', nullable: true, additionalProperties: true },
  maxPlayers:        { type: 'number', nullable: true },
  sessionDurationMs: { type: 'number', nullable: true },
  maxQueueSize:      { type: 'number', nullable: true },
  gameKey:           { type: 'string', nullable: true },
  queueSize:         { type: 'number' },
  instances: {
    type: 'object',
    properties: { open: { type: 'number' }, online: { type: 'number' } },
  },
}

const errorResponse = { type: 'object', properties: { error: { type: 'string' } } }

const instanceOf = (request) => normalizeInstance(request.query?.instance)

// Routes only the logged-in operator may call (see src/plugins/auth.js).
const OPERATOR = { operator: true }

async function totemRoutes(fastify) {
  if (!fastify.mongo) {
    log.warn('MongoDB not available — totem routes disabled')
    return
  }

  const service   = new TotemService(fastify.mongo, fastify.redisPublisher)
  const queue     = new TotemQueueService(fastify, service)
  const instances = fastify.instances
  // Generous enough for legit retries/reconnects, tight enough to stop a spam
  // loop. Shared across backend processes through Redis (src/lib/rateLimit.js).
  const queueJoinRateLimit = createRateLimiter({
    name: 'queue-join', windowMs: 10_000, max: env.queueJoinRateMax,
    getRedis: () => fastify.redisPublisher,
  })
  fastify.decorate('totemQueue', queue)

  // Physical totems without a game key accept death reports from anyone who
  // has the totem id (it is in the QR). Say so at boot until it's fixed.
  fastify.addHook('onReady', async () => {
    const n = await service.repo.col.countDocuments({
      ip: { $nin: [null, ''] }, $or: [{ gameKey: { $exists: false } }, { gameKey: null }, { gameKey: '' }],
    }).catch(() => 0)
    if (n) log.warn({ totems: n }, `${n} physical totem(s) without a game key — run "npm run ops:totem-keys" or generate it in the dashboard`)
  })
  fastify.decorate('totemService', service)

  // Sweeper: expires no_show reservations and timed-out actives, and drops
  // embedded instances whose iframe has been gone longer than the grace period.
  const sweepTimer = setInterval(async () => {
    try {
      await queue.sweep()
      for (const inst of await instances.sweep()) {
        await queue.dropInstance(inst.totemId, inst.id)
      }
    } catch (err) {
      log.error({ err: err.message }, 'Sweep failed')
    }
  }, env.queueSweepMs)
  fastify.addHook('onClose', () => clearInterval(sweepTimer))
  log.info({ sweepMs: env.queueSweepMs, reserveMs: env.queueReserveMs, graceMs: env.instanceGraceMs }, 'Queue sweeper started')

  // ── Queue SSE hub ──────────────────────────────────────────────────────────
  // Waiting players get pushed a "something changed" ping so they re-check
  // their status immediately instead of waiting for the next poll tick.
  // Keyed by instanceKey — the suffix of the queue:event:* channel.
  const queueSseClients = new Map() // instanceKey → Set<res>

  if (fastify.redisSubscriber) {
    fastify.redisSubscriber.psubscribe('queue:event:*').catch(err =>
      log.error({ err: err.message }, 'Failed to subscribe to queue events'))
    fastify.redisSubscriber.on('pmessage', (pattern, channel) => {
      if (pattern !== 'queue:event:*') return
      const clients = queueSseClients.get(channel.slice('queue:event:'.length))
      if (!clients) return
      for (const res of clients) {
        try { res.write('data: {"type":"queue_changed"}\n\n') } catch { /* gone */ }
      }
    })
  }

  // ── Games ──────────────────────────────────────────────────────────────────

  fastify.get('/api/games', {
    config: OPERATOR,
    schema: {
      tags: ['Totems'], summary: 'Embeddable browser games (folders in games/)',
      response: { 200: { type: 'array', items: { type: 'string' } } },
    },
  }, async () => listGames(env.gamesDir))

  // ── CRUD ───────────────────────────────────────────────────────────────────

  fastify.post('/api/totems', {
    config: OPERATOR,
    schema: {
      tags: ['Totems'], summary: 'Create a new totem',
      body: { type: 'object', properties: totemBodyProps, required: ['name'] },
      response: {
        201: { type: 'object', properties: totemResponseProps },
        400: errorResponse,
      },
    },
  }, async (request, reply) => {
    const result = await service.createTotem(request.body ?? {})
    if (!result.ok) return reply.status(400).send({ error: result.error })
    fastify.opsNotify?.()
    return reply.status(201).send(result.totem)
  })

  fastify.get('/api/totems', {
    config: OPERATOR,
    schema: {
      tags: ['Totems'], summary: 'List all totems',
      response: { 200: { type: 'array', items: { type: 'object', properties: totemResponseProps } } },
    },
  }, async () => {
    const totems = await service.listTotems()
    for (const t of totems) {
      const list = await instances.list(t._id)
      t.instances = { open: list.length, online: list.filter(i => i.online).length }
    }
    return totems
  })

  fastify.get('/api/totems/:id', {
    config: OPERATOR,
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
    config: OPERATOR,
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
    fastify.opsNotify?.()
    return reply.status(204).send()
  })

  fastify.delete('/api/totems/:id', {
    config: OPERATOR,
    schema: {
      tags: ['Totems'], summary: 'Delete a totem (ends every session of every instance)', params: totemIdParam,
      response: { 204: { type: 'null' }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const { id } = request.params
    for (const inst of await instances.list(id)) {
      await queue.dropInstance(id, inst.id)
      fastify.instanceHub.closeInstance(id, inst.id)
      await instances.remove(id, inst.id)
    }
    await queue.endAllForTotem(id, 'manual')
    await queue.clearQueue(id)
    const result = await service.deleteTotem(id)
    if (!result.ok) return reply.status(404).send({ error: result.error })
    fastify.opsNotify?.()
    return reply.status(204).send()
  })

  // ── Instances ──────────────────────────────────────────────────────────────

  fastify.get('/api/totems/:id/instances', {
    config: OPERATOR,
    schema: {
      tags: ['Totems'], summary: 'Instances of a totem: default (physical) + open iframes',
      params: totemIdParam,
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id:        { type: 'string' },
              online:    { type: 'boolean', nullable: true },
              createdAt: { type: 'number', nullable: true },
              sessions:  { type: 'number' },
              queueSize: { type: 'number' },
            },
          },
        },
        404: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const totem = await service.findTotem(id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    const rows = [{ id: 'default', online: null, createdAt: null }, ...(await instances.list(id))]
    return Promise.all(rows.map(async (r) => ({ ...r, ...(await queue.instanceCounts(id, r.id)) })))
  })

  // ── Queue ──────────────────────────────────────────────────────────────────

  fastify.post('/api/totems/:id/queue/join', {
    preHandler: queueJoinRateLimit,
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Join totem instance: get own session or wait in line',
      params: totemIdParam,
      querystring: instanceQuery,
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
        404: errorResponse, 409: errorResponse, 410: errorResponse, 429: errorResponse, 500: errorResponse, 503: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { playerId, metadata: clientMeta } = request.body
    const metadata = { ua: request.headers['user-agent'], ip: request.ip, ...(clientMeta || {}) }
    const result = await queue.join(request.params.id, instanceOf(request), playerId, metadata)
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    return result
  })

  fastify.get('/api/totems/:id/queue/status', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Player queue status (play | queue position)',
      params: totemIdParam,
      querystring: {
        type: 'object',
        properties: { playerId: { type: 'string' }, instance: instanceProp },
        required: ['playerId'],
      },
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
        404: errorResponse, 410: errorResponse, 500: errorResponse,
      },
    },
  }, async (request, reply) => {
    const result = await queue.status(request.params.id, instanceOf(request), request.query.playerId)
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    return result
  })

  fastify.get('/api/totems/:id/queue', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Operator view of one instance: live sessions + waiting list',
      params: totemIdParam,
      querystring: instanceQuery,
      response: {
        200: {
          type: 'object',
          properties: {
            instanceId: { type: 'string' },
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
        401: errorResponse, 404: errorResponse,
      },
    },
  }, async (request, reply) => {
    // Operator, or the physical game's bridge (HUD/rotation) with the totem key.
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    if (!fastify.isGameCaller(request, totem)) return reply.status(401).send({ error: 'Totem key required' })
    const result = await queue.operatorView(request.params.id, instanceOf(request))
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    const { ok: _ok, ...view } = result
    return view
  })

  fastify.get('/api/totems/:id/queue/events', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'SSE stream of queue change pings',
      params: totemIdParam, querystring: instanceQuery,
    },
  }, async (request, reply) => {
    const key = instanceKey(request.params.id, instanceOf(request))
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    reply.raw.write('data: {"type":"connected"}\n\n')

    if (!queueSseClients.has(key)) queueSseClients.set(key, new Set())
    queueSseClients.get(key).add(reply.raw)

    const heartbeat = setInterval(() => {
      try { reply.raw.write(': ping\n\n') } catch { /* gone */ }
    }, 20_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      const set = queueSseClients.get(key)
      set?.delete(reply.raw)
      if (set && !set.size) queueSseClients.delete(key)
    })
  })

  fastify.delete('/api/totems/:id/queue/:playerId', {
    config: OPERATOR,
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
      querystring: instanceQuery,
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    await queue.kickFromQueue(request.params.id, instanceOf(request), request.params.playerId)
    log.info({ totemId: request.params.id, instanceId: instanceOf(request), playerId: request.params.playerId }, 'Player kicked from queue')
    return { ok: true }
  })

  fastify.post('/api/totems/:id/queue/clear', {
    config: OPERATOR,
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Clear the waiting list (live sessions untouched)',
      params: totemIdParam, querystring: instanceQuery,
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    await queue.clearQueue(request.params.id, instanceOf(request))
    return { ok: true }
  })

  // ── Game integration ───────────────────────────────────────────────────────
  // With playerId (from the game, possibly truncated to 8 chars): ends only
  // that player's session. Without: ends every session of the instance (reset).
  fastify.post('/api/totems/:id/end-session', {
    schema: {
      tags: ['Totems'], summary: "End one player's session (game death) or all sessions of the instance (reset)",
      params: totemIdParam,
      querystring: instanceQuery,
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
        401: errorResponse, 404: errorResponse, 500: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const inst = instanceOf(request)
    const totem = await service.findTotem(id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    // The game reports deaths with its totem key (X-Totem-Key); the operator may too.
    if (!fastify.isGameCaller(request, totem)) return reply.status(401).send({ error: 'Totem key required' })

    const { playerId } = request.body || {}
    if (playerId) {
      const session = await queue.findCurrentByPidPrefix(id, inst, playerId)
      if (!session) return reply.status(404).send({ error: 'No live session for this player' })
      const result = await queue.endSession(session._id, 'died')
      if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
      log.info({ totemId: id, instanceId: inst, playerId, sessionId: session._id }, 'Player died — session ended')
      return { ok: true, endedSessionId: session._id }
    }

    // Reset of every slot: never open, even on legacy totems without a key.
    if (!fastify.isOperator(request) && !totem.gameKey) {
      return reply.status(401).send({ error: 'Operator login or totem key required' })
    }
    const result = await queue.endAllForInstance(id, inst, 'manual')
    log.info({ totemId: id, instanceId: inst, endedCount: result.endedCount }, 'All sessions ended (operator reset)')
    return { ok: true, endedCount: result.endedCount }
  })

  // ── History ────────────────────────────────────────────────────────────────
  const sessionsRepo = new SessionRepository(fastify.mongo)

  fastify.get('/api/totems/:id/stats', {
    config: OPERATOR,
    schema: {
      tags: ['Totems'], summary: 'Plays, wait, play time, no-shows and plays per site over a period',
      params: totemIdParam,
      querystring: {
        type: 'object',
        properties: {
          range: { type: 'string', enum: Object.keys(RANGES) },
          tz:    { type: 'integer', minimum: -840, maximum: 840 },  // Date#getTimezoneOffset() of the viewer
        },
      },
      response: { 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    const range = request.query.range ?? '24h'
    const now = Date.now()
    const docs = await sessionsRepo.listForStats(request.params.id, new Date(now - RANGES[range].ms))
    return computeStats(docs, { range, now, tzOffsetMin: request.query.tz ?? 0 })
  })

  // ── Totem key (game → backend auth) ────────────────────────────────────────
  fastify.post('/api/totems/:id/game-key', {
    config: OPERATOR,
    schema: {
      tags: ['Totems'], summary: 'Generate a new totem key (the game sends it as X-Totem-Key)',
      params: totemIdParam,
      response: { 200: { type: 'object', properties: { gameKey: { type: 'string' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const result = await service.rotateGameKey(request.params.id)
    if (!result.ok) return reply.status(404).send({ error: result.error })
    fastify.opsNotify?.()
    return { gameKey: result.gameKey }
  })

  // ── QR ─────────────────────────────────────────────────────────────────────
  fastify.get('/api/totems/:id/qr', {
    schema: {
      tags: ['Totems'], summary: 'Get totem (or instance) QR code', params: totemIdParam,
      querystring: {
        type: 'object',
        properties: { format: { type: 'string', enum: ['png', 'dataurl'] }, instance: instanceProp },
      },
      response: { 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    const inst = instanceOf(request)
    const entryUrl = `${env.publicUrl}/play/totem?id=${request.params.id}` +
      (isDefaultInstance(inst) ? '' : `&instance=${encodeURIComponent(inst)}`)
    if ((request.query.format ?? 'png') === 'dataurl') {
      const dataUrl = await QRCode.toDataURL(entryUrl, { width: 300, margin: 2 })
      return { totemId: request.params.id, instanceId: inst, entryUrl, qr: dataUrl }
    }
    const buffer = await QRCode.toBuffer(entryUrl, { type: 'png', width: 300, margin: 2 })
    reply.header('Content-Type', 'image/png')
    reply.header('Cache-Control', isDefaultInstance(inst) ? 'public, max-age=3600' : 'private, max-age=600')
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
