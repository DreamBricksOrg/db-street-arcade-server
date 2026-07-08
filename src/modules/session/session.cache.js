// src/modules/session/session.cache.js
// Redis cache of the per-player session. The UDP dispatcher reads the
// 'totems' field of this HASH as its 2nd resolution layer — keep that name.

import { SessionKey } from '../../lib/channels.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('session.cache')

export class SessionCache {
  /** @param {import('ioredis').Redis} [redis] */
  constructor(redis) {
    this.redis = redis ?? null
  }

  async set(session) {
    if (!this.redis) return
    const key = SessionKey(session._id)
    const ttlSecs = Math.max(60, Math.floor((new Date(session.expiresAt) - Date.now()) / 1000))
    await this.redis.hset(key, {
      id:        session._id,
      totemId:   session.totemId ?? '',
      playerId:  session.playerId ?? '',
      status:    session.status,
      totems:    JSON.stringify(session.totems ?? []),
      expiresAt: String(new Date(session.expiresAt).getTime()),
    })
    await this.redis.expire(key, ttlSecs)
    log.debug({ sessionId: session._id, ttlSecs }, 'Session cached')
  }

  async get(sessionId) {
    if (!this.redis) return null
    const raw = await this.redis.hgetall(SessionKey(sessionId))
    if (!raw || !raw.id) return null
    return {
      _id:       raw.id,
      totemId:   raw.totemId || null,
      playerId:  raw.playerId || null,
      status:    raw.status,
      totems:    JSON.parse(raw.totems || '[]'),
      expiresAt: new Date(parseInt(raw.expiresAt, 10)),
    }
  }

  async del(sessionId) {
    if (!this.redis) return
    await this.redis.del(SessionKey(sessionId))
  }
}
