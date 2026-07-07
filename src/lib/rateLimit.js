// src/lib/rateLimit.js
// Minimal in-memory fixed-window rate limiter for a single Fastify route.
// No external dependency — sized for a single arcade venue's traffic, not a
// distributed deployment (state is per-process, not shared via Redis).

/**
 * Creates a Fastify preHandler that rejects requests once an IP exceeds
 * `max` hits within `windowMs`.
 * @param {{ windowMs: number, max: number }} opts
 * @returns {(request, reply, done: Function) => void}
 */
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map() // ip → { count, resetAt }
  let sweepCounter = 0

  return function rateLimitPreHandler(request, reply, done) {
    const key = request.ip
    const now = Date.now()

    let entry = hits.get(key)
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs }
      hits.set(key, entry)
    }

    entry.count++

    // Opportunistic cleanup so the map doesn't grow unbounded.
    if (++sweepCounter % 200 === 0) {
      for (const [ip, e] of hits) {
        if (now > e.resetAt) hits.delete(ip)
      }
    }

    if (entry.count > max) {
      reply.status(429).send({ error: 'Too many requests — try again shortly' })
      return
    }

    done()
  }
}
