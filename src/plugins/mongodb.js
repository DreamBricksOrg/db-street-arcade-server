// src/plugins/mongodb.js
// Fastify plugin: connects to MongoDB and decorates fastify.mongo.
// Also ensures required indexes are created on startup.

import fastifyMongodb from '@fastify/mongodb'
import { MongoClient } from 'mongodb'
import fp from 'fastify-plugin'
import { env } from '../config/env.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('mongodb')

async function mongoPlugin(fastify) {
  await fastify.register(fastifyMongodb, {
    forceClose: true,
    url: env.mongoUri,
    // Short timeout in dev so startup doesn't freeze for 30s
    serverSelectionTimeoutMS: env.isDev ? 3000 : 10000,
    connectTimeoutMS:         env.isDev ? 3000 : 10000,
  })

  // Probe the real connection (the driver connects lazily)
  const db = fastify.mongo.client.db()
  await db.command({ ping: 1 })

  // Connection confirmed — ensure indexes
  await ensureIndexes(db)

  log.info(`Connected: ${sanitizeUri(env.mongoUri)}`)
}

async function ensureIndexes(db) {
  const sessions = db.collection('sessions')

  // Index for fast timeout-watcher queries (soft TTL — watcher calls endSession)
  await sessions.createIndex(
    { expiresAt: 1 },
    { name: 'sessions_expires_at' },
  )

  // Fast lookup by status (active sessions list)
  await sessions.createIndex({ status: 1 }, { name: 'sessions_status' })

  // Per-player-session model: occupancy counts and player lookups per totem
  await sessions.createIndex({ totemId: 1, status: 1 }, { name: 'sessions_totem_status' })

  log.debug('Indexes verified')
}

/**
 * Standalone reachability probe — deliberately NOT run through
 * fastify.register(). See the matching comment in plugins/redis.js: once one
 * register() call rejects, avvio poisons every subsequent register() on the
 * same instance with the same cached error, so app.js only calls
 * app.register(mongoPlugin) once this probe has already confirmed success.
 * @param {string} uri
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function isMongoReachable(uri, timeoutMs = 3000) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs, connectTimeoutMS: timeoutMs })
  try {
    await client.connect()
    await client.db().command({ ping: 1 })
    return true
  } catch {
    return false
  } finally {
    await client.close().catch(() => {})
  }
}

/** Removes credentials from the URI before logging */
function sanitizeUri(uri) {
  try {
    const u = new URL(uri)
    u.password = '***'
    return u.toString()
  } catch {
    return '[invalid uri]'
  }
}

export default fp(mongoPlugin, {
  name:         'mongodb',
  dependencies: [],
})

