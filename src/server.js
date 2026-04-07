// src/server.js
// Entry point — builds the app and starts listening.
// Handles graceful shutdown on SIGTERM/SIGINT.

import { buildApp } from './app.js'
import { env } from './config/env.js'
import { createLogger } from './lib/logger.js'

const log = createLogger('server')

async function start() {
  const app = await buildApp()

  try {
    await app.listen({ port: env.port, host: env.host })
    log.info(`Server running on http://${env.host}:${env.port} [${env.nodeEnv}]`)
  } catch (err) {
    log.error({ err }, 'Failed to start server')
    process.exit(1)
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal) => {
    log.info(`Received ${signal} — shutting down gracefully...`)
    await app.close()
    log.info('Server closed.')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

start()
