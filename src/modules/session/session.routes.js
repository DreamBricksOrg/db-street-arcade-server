// src/modules/session/session.routes.js
// TASK-S6.2 — Session Routes (REST API)
// TASK-S6.3 — Session Timeout (SESSION_TIMEOUT_MS via .env, cleanup on expiry)
//
// Routes:
//   POST   /api/sessions          → createSession
//   GET    /api/sessions/:id      → getSession
//   POST   /api/sessions/:id/join → joinSession
//   DELETE /api/sessions/:id      → endSession (soft) or deleteSession (hard)
//   GET    /api/sessions/:id/qr   → QR Code PNG / data URL

import fp     from 'fastify-plugin'
import QRCode from 'qrcode'
import { SessionService }    from './session.service.js'
import { SessionRepository } from './session.repository.js'
import { createLogger }      from '../../lib/logger.js'
import { env }               from '../../config/env.js'

const log = createLogger('session.routes')

// ── Schema helpers ─────────────────────────────────────────────────────────────

const sessionIdParam = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
  required: ['id'],
}

// ── Session Timeout Watcher (S6.3) ─────────────────────────────────────────────

/**
 * Polls MongoDB for expired sessions every 30s and marks them 'finished'.
 * MongoDB TTL index handles hard deletion — this just fires the session_ended event
 * so clients can react before the document disappears.
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
        log.info({ sessionId: doc._id }, 'Session expired — cleanup')
        await service.endSession(doc._id)
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
  const repo    = new SessionRepository(fastify.mongo) // direct access for watcher

  // S6.3: start the expiry watcher
  const watcherTimer = startTimeoutWatcher(repo, service)
  fastify.addHook('onClose', () => clearInterval(watcherTimer))

  // ── POST /api/sessions ─────────────────────────────────────────────────────
  // Creates a new session. Returns sessionId and QR Code URL.
  fastify.post('/api/sessions', async (request, reply) => {
    const { totems = [], maxPlayers } = request.body ?? {}

    const session = await service.createSession({ totems, maxPlayers })

    const playUrl = `${env.publicUrl}/play/${session._id}`

    return reply.status(201).send({
      sessionId:  session._id,
      status:     session.status,
      maxPlayers: session.maxPlayers,
      expiresAt:  session.expiresAt,
      playUrl,
    })
  })

  // ── GET /api/sessions/:id ──────────────────────────────────────────────────
  fastify.get('/api/sessions/:id', { schema: { params: sessionIdParam } }, async (request, reply) => {
    const session = await service.findSession(request.params.id)

    if (!session) return reply.status(404).send({ error: 'Session not found' })

    return {
      sessionId:  session._id ?? session.id,
      status:     session.status,
      maxPlayers: session.maxPlayers,
      players:    session.players ?? [],
      totems:     session.totems  ?? [],
      expiresAt:  session.expiresAt,
    }
  })

  // ── POST /api/sessions/:id/join ────────────────────────────────────────────
  // REST join endpoint — used when WebSocket is not available (fallback).
  // Normal flow uses WebSocket; this is for API clients.
  fastify.post('/api/sessions/:id/join', { schema: { params: sessionIdParam } }, async (request, reply) => {
    const { playerId } = request.body ?? {}

    if (!playerId) return reply.status(400).send({ error: 'playerId is required' })

    const result = await service.joinSession(request.params.id, playerId)

    if (!result.ok) {
      const status = result.error === 'Session not found' ? 404 : 409
      return reply.status(status).send({ error: result.error })
    }

    const s = result.session
    return {
      sessionId: s._id,
      status:    s.status,
      players:   s.players ?? [],
    }
  })

  // ── DELETE /api/sessions/:id ───────────────────────────────────────────────
  // Soft-ends + hard-deletes the session.
  fastify.delete('/api/sessions/:id', { schema: { params: sessionIdParam } }, async (request, reply) => {
    // Soft-end first (fires session_ended event)
    await service.endSession(request.params.id)
    // Then hard-delete from MongoDB + Redis
    const result = await service.deleteSession(request.params.id)

    if (!result.ok) return reply.status(404).send({ error: result.error })

    return reply.status(204).send()
  })

  // ── GET /api/sessions/:id/qr ───────────────────────────────────────────────
  // Returns a QR code image (PNG) pointing to the play URL.
  // ?format=png (default) | ?format=dataurl
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

    // Default: PNG buffer
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
