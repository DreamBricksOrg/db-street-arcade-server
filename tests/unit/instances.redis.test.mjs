// tests/unit/instances.redis.test.mjs — shared (Redis) instance registry.
// A tiny in-memory stand-in implements the handful of Redis commands used;
// two registries on the same fake = two backend processes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRedisInstanceRegistry } from '../../src/lib/instances.redis.js'

class FakeRedis {
  constructor() { this.h = new Map(); this.s = new Map(); this.kv = new Map() }
  _h(k) { if (!this.h.has(k)) this.h.set(k, new Map()); return this.h.get(k) }
  _s(k) { if (!this.s.has(k)) this.s.set(k, new Set()); return this.s.get(k) }
  async hget(k, f) { return this.h.get(k)?.get(f) ?? null }
  async hset(k, f, v) { this._h(k).set(f, v); return 1 }
  async hdel(k, f) { return this.h.get(k)?.delete(f) ? 1 : 0 }
  async hlen(k) { return this.h.get(k)?.size ?? 0 }
  async hgetall(k) { return Object.fromEntries(this.h.get(k) ?? []) }
  async sadd(k, m) { this._s(k).add(m); return 1 }
  async srem(k, m) { return this.s.get(k)?.delete(m) ? 1 : 0 }
  async scard(k) { return this.s.get(k)?.size ?? 0 }
  async smembers(k) { return [...(this.s.get(k) ?? [])] }
  async set(k, v, _px, _ms, nx) { if (nx && this.kv.has(k)) return null; this.kv.set(k, v); return 'OK' }
  async get(k) { return this.kv.get(k) ?? null }
  async del(k) { return this.kv.delete(k) ? 1 : 0 }
}

function setup(opts = {}) {
  let t = 1_000_000
  const clock = { now: () => t, advance: (ms) => { t += ms } }
  const redis = new FakeRedis()
  const closed = []
  const make = () => createRedisInstanceRegistry({
    redis, now: clock.now, graceMs: 1000, heartbeatMs: 250, maxPerIp: 2, maxPerTotem: 3,
    onClosed: (tid, iid) => closed.push(`${tid}|${iid}`), ...opts,
  })
  return { a: make(), b: make(), clock, redis, closed }
}

const conn = () => ({})

test('attach registra no Redis; outro processo enxerga a instância viva', async () => {
  const { a, b } = setup()
  assert.equal((await a.attach('t1', 'i1', conn(), '1.1.1.1')).ok, true)
  assert.equal(await b.isLive('t1', 'i1'), true)
  const [row] = await b.list('t1')
  assert.equal(row.id, 'i1')
  assert.equal(row.online, true)
})

test('id inválido → 400', async () => {
  const { a } = setup()
  assert.equal((await a.attach('t1', '../x', conn())).code, 400)
})

test('limite por IP e por totem valem entre processos; reconexão permitida', async () => {
  const { a, b } = setup()
  await a.attach('t1', 'i1', conn(), '9.9.9.9')
  await b.attach('t1', 'i2', conn(), '9.9.9.9')
  assert.equal((await a.attach('t1', 'i3', conn(), '9.9.9.9')).code, 429, 'IP')
  assert.equal((await b.attach('t1', 'i1', conn(), '9.9.9.9')).ok, true, 'reconectar instância conhecida')
  await a.attach('t1', 'i4', conn(), '1.1.1.1')
  assert.equal((await a.attach('t1', 'i5', conn(), '2.2.2.2')).code, 429, 'totem cheio (3)')
  assert.equal((await a.attach('t1', 'l1', conn(), '127.0.0.1')).code, 429, 'loopback ainda respeita o limite do totem')
})

test('restart: instância sem stream continua viva dentro da folga e o sweep não a derruba', async () => {
  const { a, b, clock } = setup()
  const c = conn()
  await a.attach('t1', 'i1', c, '1.1.1.1')
  await a.detach('t1', 'i1', c)           // processo A caiu / iframe reconectando
  clock.advance(900)
  assert.equal(await b.isLive('t1', 'i1'), true)
  assert.deepEqual(await b.sweep(), [])
  await b.attach('t1', 'i1', conn(), '1.1.1.1') // reconectou no processo B
  clock.advance(5_000)
  await b.heartbeat()
  assert.equal(await a.isLive('t1', 'i1'), true, 'heartbeat do B mantém viva')
})

test('sem heartbeat além da folga: sweep derruba uma vez só, mesmo com dois processos', async () => {
  const { a, b, clock } = setup()
  const c = conn()
  await a.attach('t1', 'i1', c, '1.1.1.1')
  await a.detach('t1', 'i1', c)
  clock.advance(1_001)
  assert.equal(await a.isLive('t1', 'i1'), false)
  const first = await a.sweep()
  const second = await b.sweep()
  assert.deepEqual(first, [{ totemId: 't1', id: 'i1' }])
  assert.deepEqual(second, [])
  assert.deepEqual(await b.list('t1'), [])
  assert.equal((await a.attach('t1', 'novo', conn(), '1.1.1.1')).ok, true, 'vaga de IP liberada')
})

test('online cai assim que o último stream fecha (antes da folga acabar)', async () => {
  const { a, clock } = setup()
  const c = conn()
  await a.attach('t1', 'i1', c, '1.1.1.1')
  await a.detach('t1', 'i1', c)
  clock.advance(1)
  const [row] = await a.list('t1')
  assert.equal(row.online, false)
  assert.equal(await a.isLive('t1', 'i1'), true)
})

test('instância removida em outro processo: heartbeat fecha os streams locais', async () => {
  const { a, b, closed } = setup()
  await a.attach('t1', 'i1', conn(), '1.1.1.1')
  await b.remove('t1', 'i1')
  await a.heartbeat()
  assert.deepEqual(closed, ['t1|i1'])
})
