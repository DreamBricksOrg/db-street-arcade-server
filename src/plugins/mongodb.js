// src/plugins/mongodb.js
// Fastify plugin: connects to MongoDB and decorates fastify.mongo.
// Also ensures required indexes are created on startup.

import fastifyMongodb from '@fastify/mongodb'
import { MongoClient } from 'mongodb'
import fp from 'fastify-plugin'
import { env } from '../config/env.js'

const RETENTION_INDEX = 'sessions_finished_ttl'
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

  // n→n: occupancy is counted per instance (iframe) of a totem
  await sessions.createIndex(
    { totemId: 1, instanceId: 1, status: 1 },
    { name: 'sessions_totem_instance_status' },
  )

  // Per-totem history (GET /api/totems/:id/stats)
  await sessions.createIndex({ totemId: 1, createdAt: -1 }, { name: 'sessions_totem_created' })

  await ensureRetention(db, sessions, env.sessionRetentionDays)

  log.debug('Indexes verified')
}

/**
 * Finished sessions expire `days` after endedAt (MongoDB TTL monitor, ~1/min).
 * Live sessions have endedAt=null and are never touched. Changing the env
 * value updates the index in place (collMod); 0 removes it.
 */
async function ensureRetention(db, sessions, days) {
  const existing = (await sessions.indexes()).find(i => i.name === RETENTION_INDEX)
  if (!days || days <= 0) {
    if (existing) await sessions.dropIndex(RETENTION_INDEX)
    return
  }
  const seconds = Math.round(days * 86_400)
  if (!existing) {
    await sessions.createIndex({ endedAt: 1 }, { name: RETENTION_INDEX, expireAfterSeconds: seconds })
  } else if (existing.expireAfterSeconds !== seconds) {
    await db.command({ collMod: sessions.collectionName, index: { name: RETENTION_INDEX, expireAfterSeconds: seconds } })
  }
  log.debug({ days }, 'Finished-session retention set')
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

