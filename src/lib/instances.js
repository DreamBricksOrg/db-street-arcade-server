// src/lib/instances.js
// In-memory registry of WEB instances: one per iframe load of an embedded
// totem. Each instance owns its queue, sessions, QR and phones (see
// docs/superpowers/specs/2026-10-06-n-para-n-instancias-design.md).
//
// The physical totem is the implicit 'default' instance and never lives here.
// An instance is "online" while ≥1 SSE connection (the game iframe) is open;
// after the last one closes it stays "live" for graceMs (reloads/reconnects)
// before sweep() drops it.
//
// Pure module — no I/O, clock injectable for tests.

const ID_RE    = /^[A-Za-z0-9_-]{1,64}$/
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function createInstanceRegistry({
  now         = Date.now,
  graceMs     = 120_000,
  maxPerIp    = 20,
  maxPerTotem = 2000,
} = {}) {
  /** totemId → Map<instanceId, inst> */
  const byTotem = new Map()

  const key = (totemId) => {
    if (!byTotem.has(totemId)) byTotem.set(totemId, new Map())
    return byTotem.get(totemId)
  }

  const validId = (id) => typeof id === 'string' && id !== 'default' && ID_RE.test(id)

  const get = (totemId, instanceId) => byTotem.get(totemId)?.get(instanceId) ?? null

  function countByIp(ip) {
    let n = 0
    for (const map of byTotem.values()) {
      for (const inst of map.values()) if (inst.ip === ip) n++
    }
    return n
  }

  function attach(totemId, instanceId, conn, ip = null) {
    if (!validId(instanceId)) return { ok: false, code: 400, error: 'Invalid instance id' }

    const existing = get(totemId, instanceId)
    if (existing) {
      existing.conns.add(conn)
      existing.lastSeenAt = now()
      return { ok: true, inst: existing }
    }

    if (key(totemId).size >= maxPerTotem) {
      return { ok: false, code: 429, error: 'Too many open screens for this totem' }
    }
    if (ip && !LOOPBACK.has(ip) && countByIp(ip) >= maxPerIp) {
      return { ok: false, code: 429, error: 'Too many open screens from this address' }
    }

    const inst = {
      totemId,
      id:         instanceId,
      ip,
      conns:      new Set([conn]),
      createdAt:  now(),
      lastSeenAt: now(),
    }
    key(totemId).set(instanceId, inst)
    return { ok: true, inst }
  }

  function detach(totemId, instanceId, conn) {
    const inst = get(totemId, instanceId)
    if (!inst || !inst.conns.delete(conn)) return
    inst.lastSeenAt = now()
  }

  function isLive(totemId, instanceId) {
    const inst = get(totemId, instanceId)
    if (!inst) return false
    return inst.conns.size > 0 || now() - inst.lastSeenAt <= graceMs
  }

  function list(totemId) {
    const map = byTotem.get(totemId)
    if (!map) return []
    return [...map.values()].map(i => ({
      id:         i.id,
      online:     i.conns.size > 0,
      createdAt:  i.createdAt,
      lastSeenAt: i.lastSeenAt,
    }))
  }

  function remove(totemId, instanceId) {
    const map = byTotem.get(totemId)
    if (!map) return
    map.delete(instanceId)
    if (!map.size) byTotem.delete(totemId)
  }

  /** Drops instances offline for longer than graceMs and returns them. */
  function sweep() {
    const dropped = []
    for (const [totemId, map] of byTotem) {
      for (const inst of map.values()) {
        if (inst.conns.size === 0 && now() - inst.lastSeenAt > graceMs) {
          dropped.push({ totemId, id: inst.id })
        }
      }
    }
    for (const d of dropped) remove(d.totemId, d.id)
    return dropped
  }

  function totals() {
    let instances = 0, online = 0
    for (const map of byTotem.values()) {
      for (const inst of map.values()) {
        instances++
        if (inst.conns.size > 0) online++
      }
    }
    return { instances, online }
  }

  return { validId, attach, detach, get, isLive, list, remove, sweep, totals }
}
