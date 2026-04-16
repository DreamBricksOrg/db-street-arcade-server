// src/app.js
// Fastify application factory.
// Boot order: Static → Redis → MongoDB → WebSocket → UDP → Session (F7)

import Fastify from 'fastify'
import { env } from './config/env.js'
import { logger, createLogger } from './lib/logger.js'
import redisPlugin     from './plugins/redis.js'
import mongoPlugin     from './plugins/mongodb.js'
import websocketPlugin from './plugins/websocket.js'
import udpPlugin       from './plugins/udp.js'
import staticPlugin    from './plugins/static.js'
import gameRoutes      from './modules/game/game.routes.js'
import sessionRoutes   from './modules/session/session.routes.js'
import totemRoutes     from './modules/totem/totem.routes.js'
import { UdpDispatcher } from './modules/udp/udp.dispatcher.js'

const log = createLogger('app')

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: env.isProd,
  })

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/health', async () => ({ status: 'ok', ts: Date.now() }))

  // ── Phase 7: Static files + /play/:sessionId ─────────────────────────────
  await app.register(staticPlugin)

  // ── Phase 3: Redis ────────────────────────────────────────────────────────
  try {
    await app.register(redisPlugin)
  } catch (err) {
    if (env.isDev) {
      log.warn({ err: err.message }, 'Redis unavailable — pub/sub disabled')
    } else {
      throw err
    }
  }

  // ── Phase 2: MongoDB ──────────────────────────────────────────────────────
  try {
    await app.register(mongoPlugin)
  } catch (err) {
    if (env.isDev) {
      log.warn({ err: err.message }, 'MongoDB unavailable — some features disabled')
    } else {
      throw err
    }
  }

  // ── Phase 4: WebSocket + Game Routes ─────────────────────────────────────
  await app.register(websocketPlugin)
  await app.register(gameRoutes)

  // ── Phase 5: UDP ──────────────────────────────────────────────────────────
  await app.register(udpPlugin)

  // ── Phase 6: Session + Totem REST API ──────────────────────────────────────
  await app.register(sessionRoutes)
  await app.register(totemRoutes)

  // Start UDP dispatcher after all plugins are ready.
  // onReady fires after app.listen() completes — all decorators are available.
  app.addHook('onReady', async () => {
    if (!app.redisSubscriber) {
      log.warn('Redis unavailable — UDP dispatcher not started')
      return
    }
    const dispatcher = new UdpDispatcher(app)
    await dispatcher.start()
    // Expose dispatcher so GameHandler.onConnect() can call registerSession()
    app.decorate('udpDispatcher', dispatcher)
    log.info('UDP dispatcher ready')
  })

  return app
}
