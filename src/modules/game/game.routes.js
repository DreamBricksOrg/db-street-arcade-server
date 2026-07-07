// src/modules/game/game.routes.js
// Fastify route definitions for the game WebSocket endpoint.
// Session CRUD is handled by session.routes — this file only owns the WS endpoint.

import { GameHandler } from './game.handler.js'
import fp from 'fastify-plugin'

async function gameRoutes(fastify) {
  const handler = new GameHandler(fastify)

  // Expose so SessionService can force-disconnect a specific player's socket
  // (e.g. when they die in a multiplayer game and are replaced from the queue).
  fastify.decorate('gameHandler', handler)

  // ── WebSocket endpoint ─────────────────────────────────────────────────────
  // Client connects with: ws://host:port/ws/game?sessionId=XX&playerId=YY
  fastify.get(
    '/ws/game',
    { websocket: true },
    (socket, request) => handler.onConnect(socket, request),
  )
}

export default fp(gameRoutes, {
  name:         'game-routes',
  dependencies: ['websocket'],
})
