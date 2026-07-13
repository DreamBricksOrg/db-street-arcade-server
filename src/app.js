// src/app.js
// Fastify application factory.
// Boot order: Static → Redis → MongoDB → WebSocket → UDP → Session (F7)

import Fastify from 'fastify'
import { env } from './config/env.js'
import { logger, createLogger } from './lib/logger.js'
import redisPlugin, { isRedisReachable } from './plugins/redis.js'
import mongoPlugin, { isMongoReachable } from './plugins/mongodb.js'
import websocketPlugin from './plugins/websocket.js'
import udpPlugin       from './plugins/udp.js'
import staticPlugin    from './plugins/static.js'
import swaggerPlugin   from './plugins/swagger.js'
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
  // Reachability is probed BEFORE app.register(): avvio treats any rejected
  // plugin registration as boot-fatal for the whole instance — once one
  // register() call fails, every later register() call on this same `app`
  // rejects with that same cached error too, even inside its own try/catch.
  // Registering only after confirming the connection works keeps a down
  // Redis/Mongo an isolated warning in dev instead of a cascading crash.
  if (await isRedisReachable(env.redisUrl)) {
    await app.register(redisPlugin)
  } else if (env.isDev) {
    log.warn('Redis unavailable — pub/sub disabled')
  } else {
    throw new Error(`Redis unreachable: ${env.redisUrl}`)
  }

  // ── Phase 2: MongoDB ──────────────────────────────────────────────────────
  if (await isMongoReachable(env.mongoUri)) {
    await app.register(mongoPlugin)
  } else if (env.isDev) {
    log.warn('MongoDB unavailable — some features disabled')
  } else {
    throw new Error(`MongoDB unreachable: ${env.mongoUri}`)
  }

  // ── Phase 4: WebSocket + Game Routes ─────────────────────────────────────
  await app.register(websocketPlugin)
  await app.register(gameRoutes)

  // ── Phase 4.5: Swagger Documentation ──────────────────────────────────────
  await app.register(swaggerPlugin)

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
