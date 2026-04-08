// src/plugins/websocket.js
// Fastify plugin: registers @fastify/websocket so other routes
// can use the `websocket: true` option.
// This plugin is intentionally minimal — all WS logic lives in game.handler.js.

import fastifyWs from '@fastify/websocket'
import fp from 'fastify-plugin'

async function websocketPlugin(fastify) {
  await fastify.register(fastifyWs, {
    // Underlying ws server options
    options: {
      // Allow up to 512 bytes per message for game inputs
      maxPayload: 512,
    },
  })
}

export default fp(websocketPlugin, {
  name:         'websocket',
  dependencies: [],
})
