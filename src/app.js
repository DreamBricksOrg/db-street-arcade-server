// src/app.js
// Fastify application factory.
// Registers plugins and routes in the correct boot order.

import Fastify from 'fastify'
import { env } from './config/env.js'
import { logger } from './lib/logger.js'
import mongoPlugin from './plugins/mongodb.js'
import { createLogger } from './lib/logger.js'

const log = createLogger('app')

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: env.isProd,
  })

  // ── Health check (no plugins required) ──────────────────────────────────
  app.get('/health', async () => ({ status: 'ok', ts: Date.now() }))

  // ── Plugin boot order (critical — must respect this sequence) ────────────
  // Phase 3: Redis  ← loaded here when implemented

  // Phase 2: MongoDB
  try {
    await app.register(mongoPlugin)
  } catch (err) {
    if (env.isDev) {
      log.warn({ err: err.message }, 'MongoDB not available — some features will be disabled')
    } else {
      throw err // in production, fail fast
    }
  }

  // Phase 4: WebSocket ← loaded here when implemented
  // Phase 5: UDP ← loaded here when implemented
  // Phase 6: Session routes ← loaded here when implemented

  return app
}
