// src/config/env.js
// Validates and exports environment variables.
// Fails fast on startup if a required variable is missing.

import 'dotenv/config'

const required = ['MONGO_URI', 'REDIS_URL', 'UDP_HOST', 'UDP_PORT']

for (const key of required) {
  if (!process.env[key]) {
    console.error(`[env] Missing required environment variable: ${key}`)
    process.exit(1)
  }
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

  // Public URL (for QR Code)
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',

  get isDev() { return this.nodeEnv === 'development' },
  get isProd() { return this.nodeEnv === 'production' },
}
