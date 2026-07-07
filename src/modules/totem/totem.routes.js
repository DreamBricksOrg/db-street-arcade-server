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
import { TotemService }    from './totem.service.js'
import { createLogger }    from '../../lib/logger.js'
import { env }             from '../../config/env.js'
import { createRateLimiter } from '../../lib/rateLimit.js'
import { createKeyedMutex }  from '../../lib/mutex.js'

const log = createLogger('totem.routes')

// Generous enough for legit retries/reconnects, tight enough to stop a spam loop.
const queueJoinRateLimit = createRateLimiter({ windowMs: 10_000, max: 8 })

// Serializes "resolve/create session + check capacity + claim a slot" per
// totemId. Without this, several phones scanning the QR at the same instant
// can all read "session has a free slot" before any of them actually claims
// it — handing out the same sessionId past capacity, or racing to create
// duplicate sessions for the same totem.
const totemSessionLock = createKeyedMutex()

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

  /**
   * Rough ETA for a queued player: how many "rounds" of the totem they need
   * to wait through (ceil(position / maxPlayers)) times the average real
   * duration of that totem's recent rounds.
   */
  async function estimateWait(totemId, totem, maxPlayers, position) {
    if (!fastify.sessionService) return null
    const fallback = totem.sessionDurationMs ?? env.sessionTimeoutMs
    const avgMs    = await fastify.sessionService.getAverageSessionDurationMs(totemId, fallback)
    const mp       = maxPlayers || 1
    return Math.ceil(position / mp) * avgMs
  }

  // ── Queue SSE hub ────────────────────────────────────────────────────────────
  // Lets waiting players get pushed a "something changed" ping instead of only
  // relying on their own poll interval — they re-check status immediately.
  // One shared Redis pattern-subscription (queue:event:*) fans out in-process
  // to whichever totem's SSE clients are currently connected.
  const queueSseClients = new Map() // totemId → Set<http.ServerResponse>

  function broadcastQueueEvent(totemId) {
    const clients = queueSseClients.get(totemId)
    if (!clients || clients.size === 0) return
    for (const res of clients) {
      try { res.write('data: {"type":"queue_changed"}\n\n') } catch { /* client gone */ }
    }
  }

  if (fastify.redisSubscriber) {
    fastify.redisSubscriber.psubscribe('queue:event:*').catch(err =>
      log.error({ err: err.message }, 'Failed to subscribe to queue events'))

    fastify.redisSubscriber.on('pmessage', (pattern, channel) => {
      if (pattern !== 'queue:event:*') return
      const totemId = channel.slice('queue:event:'.length)
      broadcastQueueEvent(totemId)
    })
  }

  // ── POST /api/totems ─────────────────────────────────────────────────────────
  fastify.post('/api/totems', {
    schema: {
      tags: ['Totems'],
      summary: 'Create a new totem',
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          ip: { type: 'string' },
          udpPort: { type: 'number' },
          maxPlayers: { type: 'number' },
          sessionDurationMs: { type: 'number' },
          maxQueueSize: { type: 'number' }
        },
        required: ['name', 'ip', 'udpPort']
      },
      response: {
        201: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            ip: { type: 'string' },
            udpPort: { type: 'number' },
            maxPlayers: { type: 'number', nullable: true },
            sessionDurationMs: { type: 'number', nullable: true },
            maxQueueSize: { type: 'number', nullable: true },
            currentSessionId: { type: 'string', nullable: true }
          }
        },
        400: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const { name, ip, udpPort, maxPlayers, sessionDurationMs, maxQueueSize } = request.body ?? {}

    const result = await service.createTotem({
      name,
      ip,
      udpPort:           Number(udpPort),
      maxPlayers:        maxPlayers        ? Number(maxPlayers)        : undefined,
      sessionDurationMs: sessionDurationMs ? Number(sessionDurationMs) : undefined,
      maxQueueSize:      maxQueueSize      ? Number(maxQueueSize)      : undefined,
    })

    if (!result.ok) return reply.status(400).send({ error: result.error })

    return reply.status(201).send(result.totem)
  })

  // ── GET /api/totems ──────────────────────────────────────────────────────────
  fastify.get('/api/totems', {
    schema: {
      tags: ['Totems'],
      summary: 'List all totems',
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              _id: { type: 'string' },
              name: { type: 'string' },
              ip: { type: 'string' },
              udpPort: { type: 'number' },
              maxPlayers: { type: 'number', nullable: true },
              sessionDurationMs: { type: 'number', nullable: true },
              maxQueueSize: { type: 'number', nullable: true },
              currentSessionId: { type: 'string', nullable: true },
              queueSize: { type: 'number' }
            }
          }
        }
      }
    }
  }, async () => {
    return service.listTotems()
  })

  // ── GET /api/totems/:id ──────────────────────────────────────────────────────
  fastify.get('/api/totems/:id', {
    schema: {
      tags: ['Totems'],
      summary: 'Get a totem by ID',
      params: totemIdParam,
      response: {
        200: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            ip: { type: 'string' },
            udpPort: { type: 'number' },
            maxPlayers: { type: 'number', nullable: true },
            sessionDurationMs: { type: 'number', nullable: true },
            maxQueueSize: { type: 'number', nullable: true },
            currentSessionId: { type: 'string', nullable: true }
          }
        },
        404: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    return totem
  })

  // ── PUT /api/totems/:id ──────────────────────────────────────────────────────
  fastify.put('/api/totems/:id', {
    schema: {
      tags: ['Totems'],
      summary: 'Update a totem',
      params: totemIdParam,
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          ip: { type: 'string' },
          udpPort: { type: 'number' },
          maxPlayers: { type: 'number' },
          sessionDurationMs: { type: 'number' },
          maxQueueSize: { type: 'number', nullable: true }
        }
      },
      response: {
        204: { type: 'null' },
        400: { type: 'object', properties: { error: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const { name, ip, udpPort, maxPlayers, sessionDurationMs, maxQueueSize } = request.body ?? {}

    const fields = {}
    if (name              !== undefined) fields.name              = name
    if (ip                !== undefined) fields.ip                = ip
    if (udpPort           !== undefined) fields.udpPort           = Number(udpPort)
    if (maxPlayers        !== undefined) fields.maxPlayers        = Number(maxPlayers)
    if (sessionDurationMs !== undefined) fields.sessionDurationMs = Number(sessionDurationMs)
    if (maxQueueSize      !== undefined) fields.maxQueueSize      = maxQueueSize

    const result = await service.updateTotem(request.params.id, fields)

    if (!result.ok) {
      const status = result.error === 'Totem not found' ? 404 : 400
      return reply.status(status).send({ error: result.error })
    }

    return reply.status(204).send()
  })

  // ── DELETE /api/totems/:id ───────────────────────────────────────────────────
  fastify.delete('/api/totems/:id', {
    schema: {
      tags: ['Totems'],
      summary: 'Delete a totem',
      params: totemIdParam,
      response: {
        204: { type: 'null' },
        404: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const result = await service.deleteTotem(request.params.id)
    if (!result.ok) return reply.status(404).send({ error: result.error })
    return reply.status(204).send()
  })

  // ── GET /api/totems/:id/session ─────────────────────────────────────────────
  // Returns the active session for this totem, creating one if needed. (LEGACY FLOW, TO BE UPDATED)
  fastify.get('/api/totems/:id/session', {
    schema: {
      tags: ['Totems'],
      summary: 'Get active session for totem (Legacy)',
      params: totemIdParam,
      response: {
        200: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            totemId: { type: 'string' },
            status: { type: 'string' },
            maxPlayers: { type: 'number' },
            expiresAt: { type: 'string' },
            playUrl: { type: 'string' }
          }
        },
        404: { type: 'object', properties: { error: { type: 'string' } } },
        500: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    // Shares the per-totem lock with queue/join — also resolves/creates a
    // session, so it must not race a concurrent join into a duplicate one.
    const result = await totemSessionLock(request.params.id, () => service.resolveSession(request.params.id))

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

  // ── QUEUE SYSTEM ENDPOINTS ──────────────────────────────────────────────────

  /**
   * POST /api/totems/:id/queue/join
   * Body: { playerId }
   * Enters the queue if session is full, or joins session if space is available.
   */
  fastify.post('/api/totems/:id/queue/join', {
    preHandler: queueJoinRateLimit,
    schema: {
      tags: ['Totems', 'Queue'],
      summary: 'Join totem queue',
      params: totemIdParam,
      body: {
        type: 'object',
        properties: {
          playerId: { type: 'string' },
          metadata: { type: 'object', additionalProperties: true }
        },
        required: ['playerId']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['play', 'queue'] },
            sessionId: { type: 'string' },
            position: { type: 'number' },
            estimatedWaitMs: { type: 'number', nullable: true }
          }
        },
        400: { type: 'object', properties: { error: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
        409: { type: 'object', properties: { error: { type: 'string' } } },
        429: { type: 'object', properties: { error: { type: 'string' } } },
        500: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params
    const { playerId, metadata: clientMeta } = request.body || {}
    if (!playerId) return reply.status(400).send({ error: 'playerId is required' })

    // Build metadata from headers + body
    const metadata = {
      ua: request.headers['user-agent'],
      ip: request.ip,
      ...(clientMeta || {})
    }

    const totem = await service.findTotem(id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    // Whole decide-and-claim flow is serialized per totem so concurrent
    // joiners can't all see the same "free slot" before any of them claims it.
    const outcome = await totemSessionLock(id, async () => {
      const sessionRes = await service.resolveSession(id)
      if (!sessionRes.ok) return { httpStatus: 500, error: sessionRes.error }
      const session = sessionRes.session
      const sid = (session._id ?? session.id).toString()
      const svc = fastify.sessionService

      const allowed  = session.allowedPlayers || []
      const players  = session.players || []
      const queueSize = service._redisPub ? await service._redisPub.llen(`queue:totem:${id}`) : 0

      // 1. Reserved by the queue (was dequeued) → play and claim slot
      if (allowed.includes(playerId)) {
        await service.leaveQueue(id, playerId)
        const joined = svc ? await svc.joinSession(sid, playerId, metadata) : { ok: true }
        if (joined.ok) return { status: 'play', sessionId: sid }
        // Slot vanished between the check and the claim — fall through to queue.
      } else {
        // 2. Effective occupied = joined players + allowedPlayers not yet connected
        const unclaimedReservations = allowed.filter(aid => !players.some(p => p.id === aid)).length
        const occupied = players.length + unclaimedReservations

        // 3. No queue and free slots → play directly and claim the slot
        if (queueSize === 0 && occupied < session.maxPlayers) {
          const joined = svc ? await svc.joinSession(sid, playerId, metadata) : { ok: true }
          if (joined.ok) return { status: 'play', sessionId: sid }
        }
      }

      // 4. Full, queue exists, or the claim above failed → wait in line
      const result = await service.joinQueue(id, playerId, metadata)
      if (!result.ok) {
        if (result.full) return { httpStatus: 409, error: result.error }
        return { httpStatus: 500, error: result.error }
      }

      const estimatedWaitMs = await estimateWait(id, totem, session.maxPlayers, result.position)
      return { status: 'queue', position: result.position, estimatedWaitMs }
    })

    if (outcome.httpStatus) return reply.status(outcome.httpStatus).send({ error: outcome.error })
    return outcome
  })

  /**
   * GET /api/totems/:id/queue/status
   * Query: ?playerId=X
   */
  fastify.get('/api/totems/:id/queue/status', {
    schema: {
      tags: ['Totems', 'Queue'],
      summary: 'Get player queue status',
      params: totemIdParam,
      querystring: {
        type: 'object',
        properties: { playerId: { type: 'string' } },
        required: ['playerId']
      },
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['play', 'queue'] },
            sessionId: { type: 'string' },
            position: { type: 'number' },
            size: { type: 'number' },
            estimatedWaitMs: { type: 'number', nullable: true }
          }
        },
        400: { type: 'object', properties: { error: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
        500: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params
    const { playerId } = request.query
    if (!playerId) return reply.status(400).send({ error: 'playerId requirement missing' })

    const totem = await service.findTotem(id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    // Same per-totem lock as queue/join — this route can also resolve/create
    // a session and claim a slot, so it must not race with a concurrent join.
    const outcome = await totemSessionLock(id, async () => {
      // First check if they got selected for the current session!
      const sessionRes = await service.resolveSession(id)
      if (sessionRes.ok) {
        const allowed = sessionRes.session.allowedPlayers || []
        // If player was called to play (dequeued into allowedPlayers)
        if (allowed.includes(playerId)) {
          await service.leaveQueue(id, playerId)
          const sid = (sessionRes.session._id ?? sessionRes.session.id).toString()
          const svc = fastify.sessionService
          if (svc) await svc.joinSession(sid, playerId)
          return { status: 'play', sessionId: sid }
        }
      }

      const { ok, error, position, size } = await service.getQueueStatus(id, playerId)
      if (!ok) return { httpStatus: error === 'Not in queue' ? 404 : 500, error }

      const maxPlayers = sessionRes.ok ? sessionRes.session.maxPlayers : (totem.maxPlayers ?? env.sessionMaxPlayers)
      const estimatedWaitMs = await estimateWait(id, totem, maxPlayers, position)
      return { status: 'queue', position, size, estimatedWaitMs }
    })

    if (outcome.httpStatus) return reply.status(outcome.httpStatus).send({ error: outcome.error })
    return outcome
  })

  // ── POST /api/totems/:id/end-session ─────────────────────────────────────────
  // Called by the game/totem itself when a player dies.
  // - Single-player totems (maxPlayers <= 1): ends the whole session and auto-renews
  //   (unchanged — this is the original, validated behavior).
  // - Multiplayer totems (maxPlayers > 1) with a playerId in the body: removes only
  //   that player and backfills their slot from the queue, leaving the rest of the
  //   session (and any players still alive) untouched.
  fastify.post('/api/totems/:id/end-session', {
    schema: {
      tags: ['Totems'],
      summary: 'End the active session for a totem, or remove a single player from it',
      description: 'Resolves the active session for the totem. If the totem allows more than one player and a playerId is given, only that player is removed and backfilled from the queue. Otherwise the whole session ends and auto-renews.',
      params: totemIdParam,
      body: {
        type: 'object',
        properties: { playerId: { type: 'string' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok:           { type: 'boolean' },
            newSessionId: { type: 'string' },
            backfilled:   { type: 'string', nullable: true },
          },
        },
        404: { type: 'object', properties: { error: { type: 'string' } } },
        500: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    if (!totem.currentSessionId) return reply.status(404).send({ error: 'No active session for this totem' })

    const svc = fastify.sessionService
    if (!svc) return reply.status(500).send({ error: 'SessionService not available' })

    const { playerId } = request.body || {}

    // With a playerId, let the session decide: solo totems end the whole round,
    // multiplayer totems remove only that player and backfill from the queue.
    // Without one (legacy/manual callers), always end the whole session.
    const result = playerId
      ? await svc.endPlayerTurn(totem.currentSessionId, playerId, 'player_died')
      : await svc.endSession(totem.currentSessionId, 'manual')

    if (!result.ok) return reply.status(500).send({ error: result.error })

    log.info({ totemId: request.params.id, sessionId: totem.currentSessionId, playerId, newSessionId: result.newSessionId, backfilled: result.backfilled }, 'Player turn ended via totem end-session route')
    return { ok: true, newSessionId: result.newSessionId ?? undefined, backfilled: result.backfilled ?? null }
  })

  /**
   * GET /api/totems/:id/queue
   * Returns the full ordered list of player IDs currently waiting in the queue,
   * plus the active session players for this totem.
   */
  fastify.get('/api/totems/:id/queue', {
    schema: {
      tags: ['Totems', 'Queue'],
      summary: 'Get full queue and session state for a totem',
      params: totemIdParam,
      response: {
        200: {
          type: 'object',
          properties: {
            queue:          {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id:              { type: 'string' },
                  metadata:        { type: 'object', additionalProperties: true },
                  heartbeatTtl:    { type: 'number', nullable: true },
                  estimatedWaitMs: { type: 'number', nullable: true }
                }
              }
            },
            sessionPlayers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id:          { type: 'string' },
                  connectedAt: { type: 'string' },
                  metadata:    { type: 'object', additionalProperties: true }
                },
                additionalProperties: true
              }
            },
            sessionId:      { type: 'string' },
            maxQueueSize:   { type: 'number', nullable: true },
          },
        },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params

    const totem = await service.findTotem(id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    // Full queue list from Redis
    const queueIds = service._redisPub
      ? await service._redisPub.lrange(`queue:totem:${id}`, 0, -1)
      : []

    // Fetch metadata + heartbeat TTL + ETA for each player in queue
    const queue = await Promise.all(queueIds.map(async (pid, i) => {
      const [meta, heartbeatTtl, estimatedWaitMs] = await Promise.all([
        service.getPlayerMetadata(pid),
        service.getHeartbeatTtl(pid),
        estimateWait(id, totem, totem.maxPlayers ?? env.sessionMaxPlayers, i + 1),
      ])
      return { id: pid, metadata: meta, heartbeatTtl, estimatedWaitMs }
    }))

    // Session state from Redis cache (or Mongo fallback)
    let sessionPlayers = []
    let sessionId      = totem.currentSessionId ?? null

    if (sessionId && fastify.sessionService) {
      const session = await fastify.sessionService.findSession(sessionId)
      sessionPlayers = (session?.players ?? []).filter(p => p && (p.id || p._id || typeof p === 'string'))
    }

    return {
      queue,
      sessionPlayers,
      sessionId:    sessionId ? sessionId.toString() : null,
      maxQueueSize: totem.maxQueueSize ?? null,
    }
  })

  /**
   * GET /api/totems/:id/queue/events
   * Server-Sent Events stream — pushes a ping whenever this totem's queue
   * changes (join/leave/dequeue/clear), so waiting players can re-check their
   * status immediately instead of waiting for their next poll tick.
   */
  fastify.get('/api/totems/:id/queue/events', {
    schema: {
      tags: ['Totems', 'Queue'],
      summary: 'SSE stream of queue change notifications for this totem',
      params: totemIdParam,
    },
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
      try { reply.raw.write(': ping\n\n') } catch { /* client gone */ }
    }, 20_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      queueSseClients.get(id)?.delete(reply.raw)
    })
  })

  /**
   * DELETE /api/totems/:id/queue/:playerId
   * Kicks a player from the queue. Does not affect active session.
   */
  fastify.delete('/api/totems/:id/queue/:playerId', {
    schema: {
      tags: ['Totems', 'Queue'],
      summary: 'Kick a player from the queue',
      params: {
        type:       'object',
        properties: {
          id:       { type: 'string', minLength: 36, maxLength: 36 },
          playerId: { type: 'string', minLength: 1 },
        },
        required: ['id', 'playerId'],
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { id, playerId } = request.params

    const totem = await service.findTotem(id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    await service.leaveQueue(id, playerId)
    log.info({ totemId: id, playerId }, 'Player kicked from queue by operator')
    return { ok: true }
  })

  /**
   * POST /api/totems/:id/queue/clear
   * Clears the entire queue for this totem.
   */
  fastify.post('/api/totems/:id/queue/clear', {
    schema: {
      tags: ['Totems', 'Queue'],
      summary: 'Clear the entire queue',
      params: {
        type:       'object',
        properties: {
          id:       { type: 'string', minLength: 36, maxLength: 36 },
        },
        required: ['id'],
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params

    const totem = await service.findTotem(id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    await service.clearQueue(id)
    log.info({ totemId: id }, 'Queue cleared by operator')
    return { ok: true }
  })

  // ── GET /api/totems/:id/qr ───────────────────────────────────────────────────
  // Returns a permanent QR Code PNG pointing to /play/totem?id=:totemId
  fastify.get('/api/totems/:id/qr', {
    schema: {
      tags: ['Totems'],
      summary: 'Get totem QR code',
      params: totemIdParam,
      querystring: {
        type: 'object',
        properties: { format: { type: 'string', enum: ['png', 'dataurl'] } }
      },
      response: {
        404: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
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
