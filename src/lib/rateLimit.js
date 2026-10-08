// src/lib/rateLimit.js
// Fixed-window rate limiter for a Fastify route, keyed by client IP.
//
// With Redis the counter is shared by every backend process
// (`rl:{name}:{ip}:{window}` INCR + PEXPIRE), so N replicas still allow
// `max` hits per window in total — not N × max. Without Redis (dev), or if
// Redis errors, it falls back to an in-process counter instead of failing
// open or blocking everyone.

/**
 * @param {{ windowMs: number, max: number, name?: string,
 *           getRedis?: () => import('ioredis').Redis | null | undefined,
 *           now?: () => number }} opts
 * @returns {(request, reply) => Promise<void>} Fastify preHandler
 */
export function createRateLimiter({ windowMs, max, name = 'default', getRedis = () => null, now = Date.now }) {
  const hits = new Map() // ip → { count, resetAt }  (fallback)
  let sweepCounter = 0

  function countLocally(ip, t) {
    let entry = hits.get(ip)
    if (!entry || t > entry.resetAt) {
      entry = { count: 0, resetAt: t + windowMs }
      hits.set(ip, entry)
    }
    entry.count++
    if (++sweepCounter % 200 === 0) {
      for (const [k, e] of hits) if (t > e.resetAt) hits.delete(k)
    }
    return entry.count
  }

  async function countShared(redis, ip, t) {
    const key = `rl:${name}:${ip}:${Math.floor(t / windowMs)}`
    const n = await redis.incr(key)
    if (n === 1) await redis.pexpire(key, windowMs)
    return n
  }

  return async function rateLimitPreHandler(request, reply) {
    const ip = request.ip
    const t = now()
    const redis = getRedis()
    let count
    try {
      count = redis ? await countShared(redis, ip, t) : countLocally(ip, t)
    } catch {
      count = countLocally(ip, t)
    }
    if (count > max) {
      return reply.status(429).send({ error: 'Too many requests — try again shortly' })
    }
  }
}
