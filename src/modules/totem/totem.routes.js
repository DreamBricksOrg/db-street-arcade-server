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
          sessionDurationMs: { type: 'number' }
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
            currentSessionId: { type: 'string', nullable: true }
          }
        },
        400: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
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
          sessionDurationMs: { type: 'number' }
        }
      },
      response: {
        204: { type: 'null' },
        400: { type: 'object', properties: { error: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
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

  // ── QUEUE SYSTEM ENDPOINTS ──────────────────────────────────────────────────

  /**
   * POST /api/totems/:id/queue/join
   * Body: { playerId }
   * Enters the queue if session is full, or joins session if space is available.
   */
  fastify.post('/api/totems/:id/queue/join', {
    schema: {
      tags: ['Totems', 'Queue'],
      summary: 'Join totem queue',
      params: totemIdParam,
      body: {
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
            position: { type: 'number' }
          }
        },
        400: { type: 'object', properties: { error: { type: 'string' } } },
        404: { type: 'object', properties: { error: { type: 'string' } } },
        500: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params
    const { playerId } = request.body || {}
    if (!playerId) return reply.status(400).send({ error: 'playerId is required' })

    const totem = await service.findTotem(id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    const sessionRes = await service.resolveSession(id)
    if (!sessionRes.ok) return reply.status(500).send({ error: sessionRes.error })
    const session = sessionRes.session
    const sid = (session._id ?? session.id).toString()
    const svc = fastify.sessionService

    const allowed  = session.allowedPlayers || []
    const players  = session.players || []
    const queueSize = service._redisPub ? await service._redisPub.llen(`queue:totem:${id}`) : 0

    // 1. Reserved by the queue (was dequeued) → play and claim slot
    if (allowed.includes(playerId)) {
      await service.leaveQueue(id, playerId)
      if (svc) await svc.joinSession(sid, playerId)
      return { status: 'play', sessionId: sid }
    }

    // 2. Effective occupied = joined players + allowedPlayers not yet connected
    const unclaimedReservations = allowed.filter(aid => !players.some(p => p.id === aid)).length
    const occupied = players.length + unclaimedReservations

    // 3. No queue and free slots → play directly and claim the slot
    if (queueSize === 0 && occupied < session.maxPlayers) {
      if (svc) await svc.joinSession(sid, playerId)
      return { status: 'play', sessionId: sid }
    }

    // 4. Full or queue exists → wait in line
    const result = await service.joinQueue(id, playerId)
    if (!result.ok) return reply.status(500).send({ error: result.error })
    return { status: 'queue', position: result.position }
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
            size: { type: 'number' }
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
    if (!ok) return reply.status(error === 'Not in queue' ? 404 : 500).send({ error })

    return { status: 'queue', position, size }
  })

  // ── POST /api/totems/:id/end-session ─────────────────────────────────────────
  // Ends the active session for the given totem.
  // Used by the game/totem itself when the player dies.
  fastify.post('/api/totems/:id/end-session', {
    schema: {
      tags: ['Totems'],
      summary: 'End the active session for a totem',
      description: 'Resolves the active session for the totem by ID and ends it. Used by the game client on player death.',
      params: totemIdParam,
      response: {
        200: {
          type: 'object',
          properties: {
            ok:           { type: 'boolean' },
            newSessionId: { type: 'string' },
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

    const result = await svc.endSession(totem.currentSessionId, 'manual')
    if (!result.ok) return reply.status(500).send({ error: result.error })

    log.info({ totemId: request.params.id, sessionId: totem.currentSessionId }, 'Session ended via totem end-session route')
    return { ok: true, newSessionId: result.newSessionId }
  })

  /**
   * POST /api/totems/:id/queue/clear
   */
  fastify.post('/api/totems/:id/queue/clear', {
    schema: {
      tags: ['Totems', 'Queue'],
      summary: 'Clear totem queue',
      params: totemIdParam,
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } }
        },
        500: { type: 'object', properties: { error: { type: 'string' } } }
      }
    }
  }, async (request, reply) => {
    const result = await service.clearQueue(request.params.id)
    if (!result.ok) return reply.status(500).send({ error: result.error })
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
