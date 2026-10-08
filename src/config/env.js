// src/config/env.js
// Validates and exports environment variables.
// Fails fast on startup if a required variable is missing.

import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const required = ['MONGO_URI', 'REDIS_URL', 'UDP_HOST', 'UDP_PORT']

for (const key of required) {
  if (!process.env[key]) {
    console.error(`[env] Missing required environment variable: ${key}`)
    process.exit(1)
  }
}

if (process.env.NODE_ENV === 'production' && !process.env.OPERATOR_PASSWORD) {
  console.error('[env] OPERATOR_PASSWORD is required in production (dashboard + operator API login)')
  process.exit(1)
}

export const env = {
  // Server
  port:    parseInt(process.env.PORT ?? '3000', 10),
  host:    process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',

  // MongoDB
  mongoUri: process.env.MONGO_URI,

  // Redis
  redisUrl: process.env.REDIS_URL,

  // UDP Gateway
  udpHost: process.env.UDP_HOST,
  udpPort: parseInt(process.env.UDP_PORT, 10),

  // Session
  sessionTimeoutMs:  parseInt(process.env.SESSION_TIMEOUT_MS ?? '300000', 10),
  sessionMaxPlayers: parseInt(process.env.SESSION_MAX_PLAYERS ?? '2', 10),

  // Queue — claim window for called players and sweeper cadence
  // (overridable so e2e tests can use short values)
  queueReserveMs:   parseInt(process.env.QUEUE_RESERVE_MS ?? '30000', 10),
  queueSweepMs:     parseInt(process.env.QUEUE_SWEEP_MS   ?? '10000', 10),
  queueJoinRateMax: parseInt(process.env.QUEUE_JOIN_RATE_MAX ?? '8', 10),

  // Finished sessions older than this are deleted by a MongoDB TTL index
  // (history/stats look back at most 30 days). 0 = keep forever.
  sessionRetentionDays: parseInt(process.env.SESSION_RETENTION_DAYS ?? '90', 10),

  // Operator login (dashboard + operator API). Empty = auth off (development only).
  operatorPassword: process.env.OPERATOR_PASSWORD ?? '',

  // Public URL (for QR Code)
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',

  // Web instances (embedded iframes) — see src/lib/instances.js
  instanceGraceMs:      parseInt(process.env.INSTANCE_GRACE_MS ?? '120000', 10),
  maxInstancesPerIp:    parseInt(process.env.MAX_INSTANCES_PER_IP ?? '20', 10),
  maxInstancesPerTotem: parseInt(process.env.MAX_INSTANCES_PER_TOTEM ?? '2000', 10),
  trustProxy:           ['true', '1'].includes(String(process.env.TRUST_PROXY ?? '').toLowerCase()),
  embedFrameAncestors:  process.env.EMBED_FRAME_ANCESTORS ?? '*',
  gamesDir:             path.resolve(process.env.GAMES_DIR ?? path.join(ROOT_DIR, 'games')),

  get isDev() { return this.nodeEnv === 'development' },
  get isProd() { return this.nodeEnv === 'production' },
}
