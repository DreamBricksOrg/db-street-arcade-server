// src/lib/logger.js
// Structured JSON logger via pino.
// In development, uses pino-pretty for human-readable output.

import pino from 'pino'
import { env } from '../config/env.js'

export const logger = pino({
  level: env.isDev ? 'debug' : 'info',
  ...(env.isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize:        true,
        translateTime:   'HH:MM:ss',
        ignore:          'pid,hostname',
        messageFormat:   '[{context}] {msg}',
      },
    },
  }),
})

/**
 * Creates a child logger with a fixed context label.
 * @param {string} context - Module name, e.g. 'websocket', 'redis'
 */
export const createLogger = (context) => logger.child({ context })
