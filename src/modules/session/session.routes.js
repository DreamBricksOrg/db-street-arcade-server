// src/modules/session/session.routes.js
//
// Routes:
//   POST   /api/sessions           → createSession
//   GET    /api/sessions           → listActiveSessions
//   GET    /api/sessions/:id       → getSession
//   POST   /api/sessions/:id/join  → joinSession (REST fallback)
//   POST   /api/sessions/:id/end   → endSession (manual)
//   DELETE /api/sessions/:id       → hard-delete (admin only)
//   GET    /api/sessions/:id/qr    → QR Code PNG for session

import fp     from 'fastify-plugin'
import QRCode from 'qrcode'
import { SessionService }    from './session.service.js'
import { SessionRepository } from './session.repository.js'
import { createLogger }      from '../../lib/logger.js'
import { env }               from '../../config/env.js'

const log = createLogger('session.routes')

const sessionIdParam = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
  required: ['id'],
}

// ── Session Timeout Watcher ────────────────────────────────────────────────────

/**
 * Polls MongoDB for expired sessions every 30s.
 * Calls endSession('timeout') which triggers totem auto-renew.
 *
 * @param {SessionRepository} repo
 * @param {SessionService} service
 */
function startTimeoutWatcher(repo, service) {
  const POLL_MS = 30_000

  const tick = async () => {
    try {
      const expired = await repo.col.find({
        status:    { $ne: 'finished' },
        expiresAt: { $lte: new Date() },
      }).toArray()

      for (const doc of expired) {
        log.info({ sessionId: doc._id }, 'Session expired — ending + auto-renew')
        await service.endSession(doc._id, 'timeout')
      }
    } catch (err) {
      log.error({ err: err.message }, 'Timeout watcher error')
    }
  }

  const timer = setInterval(tick, POLL_MS)
  log.info({ pollMs: POLL_MS }, 'Session timeout watcher started')
  return timer
}

// ── Route Plugin ───────────────────────────────────────────────────────────────

async function sessionRoutes(fastify) {
  if (!fastify.mongo) {
    log.warn('MongoDB not available — session routes disabled')
    return
  }

  const service = new SessionService(fastify.mongo, fastify.redisPublisher)
  const repo    = new SessionRepository(fastify.mongo)

  // Start the expiry watcher
  const watcherTimer = startTimeoutWatcher(repo, service)
  fastify.addHook('onClose', () => clearInterval(watcherTimer))

  // Expose service so totem.routes can wire the circular dependency
  fastify.decorate('sessionService', service)

  // ── POST /api/sessions ──────────────────────────────────────────────────────
  fastify.post('/api/sessions', async (request, reply) => {
    const { totems = [], maxPlayers, expiresInMs, totemId } = request.body ?? {}

    const ttlMs   = expiresInMs > 0 ? Number(expiresInMs) : undefined
    const session = await service.createSession({ totemId, totems, maxPlayers, ttlMs })

    const playUrl = `${env.publicUrl}/play/${session._id}`

    return reply.status(201).send({
      sessionId:  session._id,
      totemId:    session.totemId,
      status:     session.status,
      maxPlayers: session.maxPlayers,
      expiresAt:  session.expiresAt,
      playUrl,
    })
  })

  // ── GET /api/sessions ───────────────────────────────────────────────────────
  fastify.get('/api/sessions', async () => {
    const sessions = await service.listActiveSessions()
    return sessions.map(s => ({
      sessionId:  s._id ?? s.id,
      totemId:    s.totemId,
      status:     s.status,
      maxPlayers: s.maxPlayers,
      players:    s.players ?? [],
      totems:     s.totems  ?? [],
      createdAt:  s.createdAt,
      expiresAt:  s.expiresAt,
    }))
  })

  // ── GET /api/sessions/:id ───────────────────────────────────────────────────
  fastify.get('/api/sessions/:id', { schema: { params: sessionIdParam } }, async (request, reply) => {
    const session = await service.findSession(request.params.id)

    if (!session) return reply.status(404).send({ error: 'Session not found' })

    return {
      sessionId:  session._id ?? session.id,
      totemId:    session.totemId,
      status:     session.status,
      maxPlayers: session.maxPlayers,
      players:    session.players ?? [],
      totems:     session.totems  ?? [],
      expiresAt:  session.expiresAt,
      endedAt:    session.endedAt,
      endReason:  session.endReason,
    }
  })

  // ── POST /api/sessions/:id/join ─────────────────────────────────────────────
  fastify.post('/api/sessions/:id/join', { schema: { params: sessionIdParam } }, async (request, reply) => {
    const { playerId } = request.body ?? {}

    if (!playerId) return reply.status(400).send({ error: 'playerId is required' })

    const result = await service.joinSession(request.params.id, playerId)

    if (!result.ok) {
      const status = result.error === 'Session not found' ? 404 : 409
      return reply.status(status).send({ error: result.error })
    }

    const s = result.session
    return { sessionId: s._id ?? s.id, status: s.status, players: s.players ?? [] }
  })

  // ── POST /api/sessions/:id/end ──────────────────────────────────────────────
  // Manual session termination by operator. Triggers auto-renew for the totem.
  fastify.post('/api/sessions/:id/end', { schema: { params: sessionIdParam } }, async (request, reply) => {
    const result = await service.endSession(request.params.id, 'manual')

    if (!result.ok) return reply.status(404).send({ error: result.error })

    return {
      ok:           true,
      newSessionId: result.newSessionId ?? null,
    }
  })

  // ── DELETE /api/sessions/:id ────────────────────────────────────────────────
  // Admin hard-delete. Normal flow should use POST /:id/end instead.
  fastify.delete('/api/sessions/:id', { schema: { params: sessionIdParam } }, async (request, reply) => {
    await service.endSession(request.params.id, 'manual')
    const result = await service.deleteSession(request.params.id)

    if (!result.ok) return reply.status(404).send({ error: result.error })

    return reply.status(204).send()
  })

  // ── GET /api/sessions/:id/qr ────────────────────────────────────────────────
  fastify.get('/api/sessions/:id/qr', { schema: { params: sessionIdParam } }, async (request, reply) => {
    const session = await service.findSession(request.params.id)

    if (!session) return reply.status(404).send({ error: 'Session not found' })
    if (session.status === 'finished') return reply.status(410).send({ error: 'Session finished' })

    const playUrl = `${env.publicUrl}/play/${request.params.id}`
    const format  = request.query.format ?? 'png'

    if (format === 'dataurl') {
      const dataUrl = await QRCode.toDataURL(playUrl, { width: 300, margin: 2 })
      return { sessionId: request.params.id, playUrl, qr: dataUrl }
    }

    const buffer = await QRCode.toBuffer(playUrl, { type: 'png', width: 300, margin: 2 })
    reply.header('Content-Type', 'image/png')
    reply.header('Cache-Control', 'public, max-age=60')
    return reply.send(buffer)
  })
}

export default fp(sessionRoutes, {
  name:         'session-routes',
  dependencies: ['mongodb', 'redis'],
})
