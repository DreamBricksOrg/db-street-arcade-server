// src/lib/instances.redis.js
// Redis-backed registry of WEB instances (embedded iframes) — same contract
// as the in-memory createInstanceRegistry() in ./instances.js, but shared by
// every backend process and surviving restarts:
//
//   inst:{totemId}   HASH  instanceId → { ip, createdAt, lastSeenAt, onlineUntil }
//   inst:ip:{ip}     SET   "totemId|instanceId"  (per-IP limit)
//   inst:totems      SET   totemIds that have instances (sweep index)
//   inst:sweep-lock  STRING  one sweeper at a time across processes
//
// SSE streams are TCP connections, so they stay local to the process that
// accepted them (`conns` below). That process heartbeats every instance it
// holds a stream for; an instance is LIVE while some process heartbeated it
// within graceMs, and ONLINE while its onlineUntil is in the future. After a
// deploy/restart the iframe's EventSource reconnects within seconds, so its
// sessions never cross the grace period and nobody gets dropped.
//
// All methods are async except validId. Clock injectable for tests.

import crypto from 'node:crypto'

const ID_RE    = /^[A-Za-z0-9_-]{1,64}$/
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const hashKey  = (totemId) => `inst:${totemId}`
const ipKey    = (ip) => `inst:ip:${ip}`
const member   = (totemId, instanceId) => `${totemId}|${instanceId}`
const TOTEMS   = 'inst:totems'
const LOCK     = 'inst:sweep-lock'

export function createRedisInstanceRegistry({
  redis,
  now         = Date.now,
  graceMs     = 120_000,
  maxPerIp    = 20,
  maxPerTotem = 2000,
  heartbeatMs = Math.max(250, Math.min(10_000, Math.floor(graceMs / 3))),
  onClosed    = () => {},   // (totemId, instanceId) — instance removed elsewhere; end local streams
} = {}) {
  /** "totemId|instanceId" → Set<conn> of SSE streams held by THIS process */
  const conns = new Map()
  const owner = crypto.randomUUID()
  let timer = null

  const validId = (id) => typeof id === 'string' && id !== 'default' && ID_RE.test(id)

  async function read(totemId, instanceId) {
    const raw = await redis.hget(hashKey(totemId), instanceId)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  const write = (totemId, instanceId, rec) =>
    redis.hset(hashKey(totemId), instanceId, JSON.stringify(rec))

  const onlineUntil = () => now() + heartbeatMs * 2.5

  async function attach(totemId, instanceId, conn, ip = null) {
    if (!validId(instanceId)) return { ok: false, code: 400, error: 'Invalid instance id' }
    const k = member(totemId, instanceId)

    const existing = await read(totemId, instanceId)
    if (!existing) {
      if (await redis.hlen(hashKey(totemId)) >= maxPerTotem) {
        return { ok: false, code: 429, error: 'Too many open screens for this totem' }
      }
      if (ip && !LOOPBACK.has(ip) && await redis.scard(ipKey(ip)) >= maxPerIp) {
        return { ok: false, code: 429, error: 'Too many open screens from this address' }
      }
    }

    const rec = existing
      ? { ...existing, lastSeenAt: now(), onlineUntil: onlineUntil() }
      : { ip, createdAt: now(), lastSeenAt: now(), onlineUntil: onlineUntil() }
    await write(totemId, instanceId, rec)
    if (!existing) {
      await redis.sadd(TOTEMS, totemId)
      if (ip) await redis.sadd(ipKey(ip), k)
    }

    if (!conns.has(k)) conns.set(k, new Set())
    conns.get(k).add(conn)
    return { ok: true, inst: { totemId, id: instanceId, ...rec } }
  }

  async function detach(totemId, instanceId, conn) {
    const k = member(totemId, instanceId)
    const set = conns.get(k)
    if (!set || !set.delete(conn)) return
    if (set.size) return
    conns.delete(k)
    const rec = await read(totemId, instanceId)
    // Grace starts now; another process may still hold a stream and will
    // push onlineUntil forward again on its next heartbeat.
    if (rec) await write(totemId, instanceId, { ...rec, lastSeenAt: now(), onlineUntil: now() })
  }

  async function isLive(totemId, instanceId) {
    if (conns.get(member(totemId, instanceId))?.size) return true
    const rec = await read(totemId, instanceId)
    return Boolean(rec) && now() - rec.lastSeenAt <= graceMs
  }

  async function list(totemId) {
    const all = await redis.hgetall(hashKey(totemId))
    return Object.entries(all ?? {}).flatMap(([id, raw]) => {
      try {
        const r = JSON.parse(raw)
        const local = conns.get(member(totemId, id))?.size > 0
        return [{ id, online: local || r.onlineUntil > now(), createdAt: r.createdAt, lastSeenAt: r.lastSeenAt }]
      } catch { return [] }
    })
  }

  async function remove(totemId, instanceId) {
    const rec = await read(totemId, instanceId)
    await redis.hdel(hashKey(totemId), instanceId)
    if (rec?.ip) await redis.srem(ipKey(rec.ip), member(totemId, instanceId))
    if (!(await redis.hlen(hashKey(totemId)))) await redis.srem(TOTEMS, totemId)
  }

  /**
   * Drops instances nobody heartbeated for longer than graceMs and returns
   * them. Only one process sweeps at a time (lock), so each dropped instance
   * is returned exactly once across the cluster.
   */
  async function sweep() {
    const got = await redis.set(LOCK, owner, 'PX', Math.max(1000, heartbeatMs * 4), 'NX')
    if (!got) return []
    const dropped = []
    try {
      for (const totemId of await redis.smembers(TOTEMS)) {
        const all = await redis.hgetall(hashKey(totemId))
        for (const [id, raw] of Object.entries(all ?? {})) {
          let rec = null
          try { rec = JSON.parse(raw) } catch { /* corrupt → drop */ }
          if (conns.get(member(totemId, id))?.size) continue
          if (!rec || now() - rec.lastSeenAt > graceMs) dropped.push({ totemId, id })
        }
        if (!Object.keys(all ?? {}).length) await redis.srem(TOTEMS, totemId)
      }
      for (const d of dropped) await remove(d.totemId, d.id)
    } finally {
      if (await redis.get(LOCK) === owner) await redis.del(LOCK)
    }
    return dropped
  }

  /** Keeps every instance this process streams to alive; closes orphans. */
  async function heartbeat() {
    for (const k of [...conns.keys()]) {
      const [totemId, instanceId] = k.split('|')
      const rec = await read(totemId, instanceId)
      if (!rec) {
        // Removed by another process (totem deleted / swept): end our streams.
        conns.delete(k)
        onClosed(totemId, instanceId)
        continue
      }
      await write(totemId, instanceId, { ...rec, lastSeenAt: now(), onlineUntil: onlineUntil() })
    }
  }

  function start() {
    if (timer) return
    timer = setInterval(() => { heartbeat().catch(() => {}) }, heartbeatMs)
    timer.unref?.()
  }

  function stop() {
    clearInterval(timer)
    timer = null
  }

  function totals() {
    let instances = 0, online = 0
    for (const set of conns.values()) {
      instances++
      if (set.size) online++
    }
    return { instances, online }
  }

  return { validId, attach, detach, isLive, list, remove, sweep, heartbeat, start, stop, totals }
}
