// src/modules/game/game.routes.js
// Fastify route definitions for the game WebSocket endpoint.
// This file is the only place that touches the Fastify instance — handler logic
// is fully encapsulated in GameHandler.

import { GameHandler } from './game.handler.js'
import fp from 'fastify-plugin'

async function gameRoutes(fastify) {
  const handler = new GameHandler(fastify)

  // ── WebSocket endpoint ─────────────────────────────────────────────────────
  // Client connects with: ws://host:port/ws/game?sessionId=XX&playerId=YY
  fastify.get(
    '/ws/game',
    { websocket: true },
    (socket, request) => handler.onConnect(socket, request),
  )

  // ── REST: create a session (used by QR code flow in later phases) ──────────
  fastify.post('/sessions', async (request, reply) => {
    if (!fastify.mongo) {
      return reply.status(503).send({ error: 'MongoDB not available' })
    }

    const { totems = [], maxPlayers } = request.body ?? {}

    const { SessionRepository } = await import('../session/session.repository.js')
    const { SessionCache }      = await import('../session/session.cache.js')

    const repo    = new SessionRepository(fastify.mongo)
    const cache   = new SessionCache(fastify.redisPublisher)

    const session = await repo.createSession({ totems, maxPlayers })
    await cache.set(session)

    reply.status(201).send({
      sessionId:  session._id,
      status:     session.status,
      maxPlayers: session.maxPlayers,
      expiresAt:  session.expiresAt,
    })
  })

  // ── REST: get session state (useful for frontend debug) ───────────────────
  fastify.get('/sessions/:id', async (request, reply) => {
    if (!fastify.mongo) {
      return reply.status(503).send({ error: 'MongoDB not available' })
    }

    const { SessionRepository } = await import('../session/session.repository.js')
    const repo    = new SessionRepository(fastify.mongo)
    const session = await repo.findById(request.params.id)

    if (!session) return reply.status(404).send({ error: 'Session not found' })

    return {
      sessionId:  session._id,
      status:     session.status,
      maxPlayers: session.maxPlayers,
      players:    session.players,
      expiresAt:  session.expiresAt,
    }
  })
}

export default fp(gameRoutes, {
  name:         'game-routes',
  dependencies: ['websocket', 'mongodb', 'redis'],
})
