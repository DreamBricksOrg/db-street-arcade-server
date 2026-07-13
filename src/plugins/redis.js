// src/plugins/redis.js
// Fastify plugin: creates two separate ioredis connections.
//
// WHY TWO CONNECTIONS?
// A Redis client in subscribe mode cannot issue regular commands (GET, SET, HSET…).
// We need:
//   - redisPublisher  → regular commands + PUBLISH
//   - redisSubscriber → SUBSCRIBE / PSUBSCRIBE only
//
// Both are decorated onto the Fastify instance so any route/plugin can access them.

import { Redis } from 'ioredis'
import fp from 'fastify-plugin'
import { env } from '../config/env.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('redis')

async function redisPlugin(fastify) {
  const publisher  = createClient('publisher')
  const subscriber = createClient('subscriber')

  // Wait for both connections to be ready before proceeding
  await Promise.all([
    waitReady(publisher,  'publisher'),
    waitReady(subscriber, 'subscriber'),
  ])

  // Decorate Fastify so any plugin/route can use them
  fastify.decorate('redisPublisher',  publisher)
  fastify.decorate('redisSubscriber', subscriber)

  // Graceful shutdown — close connections when Fastify shuts down
  fastify.addHook('onClose', async () => {
    log.debug('Closing Redis connections...')
    await Promise.all([publisher.quit(), subscriber.quit()])
    log.debug('Redis connections closed')
  })

  log.info(`Connected: ${sanitizeUrl(env.redisUrl)}`)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createClient(name) {
  const client = new Redis(env.redisUrl, {
    lazyConnect:              true,
    maxRetriesPerRequest:     null,        // ioredis v5: required for block commands
    enableReadyCheck:         true,
    reconnectOnError:         (err) => {
      log.warn({ err: err.message, client: name }, 'Redis reconnecting...')
      return true
    },
  })

  client.on('error', (err) => log.error({ err: err.message, client: name }, 'Redis error'))
  client.on('reconnecting', () => log.warn({ client: name }, 'Redis reconnecting'))
  client.on('ready', () => log.debug({ client: name }, 'Redis ready'))

  return client
}

/** Resolves when the client emits 'ready', rejects on first 'error' during connect */
function waitReady(client, name) {
  return new Promise((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', (err) => reject(new Error(`Redis ${name}: ${err.message}`)))
    client.connect().catch(reject)
  })
}

function sanitizeUrl(url) {
  try {
    const u = new URL(url)
    u.password = '***'
    return u.toString()
  } catch {
    return '[invalid redis url]'
  }
}

/**
 * Standalone reachability probe — deliberately NOT run through
 * fastify.register(). Fastify/avvio treats a failed plugin registration as a
 * boot-fatal error: once one register() call rejects, every subsequent
 * register() on the same instance also rejects with that same cached error,
 * even if the earlier failure was caught locally. Testing the connection
 * here first means app.js only ever calls app.register(redisPlugin) when
 * it's already known to succeed, so a down Redis in development degrades
 * gracefully instead of cascading into every other plugin failing too.
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isRedisReachable(url, timeoutMs = 3000) {
  const probe = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null })
  probe.on('error', () => {}) // swallow — ioredis logs "Unhandled error event" to stderr otherwise
  try {
    await Promise.race([
      probe.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ])
    return true
  } catch {
    return false
  } finally {
    probe.disconnect()
  }
}

export default fp(redisPlugin, {
  name:         'redis',
  dependencies: [],
})
