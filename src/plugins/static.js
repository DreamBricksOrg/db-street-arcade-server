// src/plugins/static.js
// Serves content from the `public/` directory.
// Registers @fastify/static and adds GET /play/:sessionId (TASK-Q7.2).

import path             from 'node:path'
import { fileURLToPath } from 'node:url'
import fp               from 'fastify-plugin'
import fastifyStatic    from '@fastify/static'
import { createLogger } from '../lib/logger.js'

const log = createLogger('static')

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.resolve(__dirname, '../../public')

async function staticPlugin(fastify) {
  await fastify.register(fastifyStatic, {
    root:  PUBLIC_DIR,
    prefix: '/',
    index: ['index.html'],
  })

  log.info({ root: PUBLIC_DIR }, 'Static files ready')

  // ── TASK-Q7.2 — GET /play/:sessionId ──────────────────────────────────────
  // Serves play.html for every /play/<uuid> path.
  // The sessionId is already in the URL — the frontend JS reads it via location.pathname.
  fastify.get('/play/:sessionId', async (_request, reply) => {
    return reply.sendFile('play.html')
  })
}

export default fp(staticPlugin, { name: 'static-files' })
