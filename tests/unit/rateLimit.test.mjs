// tests/unit/rateLimit.test.mjs — fixed-window limiter, shared through Redis.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../../src/lib/rateLimit.js'

class FakeRedis {
  constructor() { this.kv = new Map(); this.fail = false }
  async incr(k) { if (this.fail) throw new Error('down'); const n = (this.kv.get(k) ?? 0) + 1; this.kv.set(k, n); return n }
  async pexpire() { return 1 }
}

function reply() {
  return { code: null, status(c) { this.code = c; return this }, send() { return this } }
}

async function hit(limiter, ip = '9.9.9.9') {
  const r = reply()
  await limiter({ ip }, r)
  return r.code ?? 200
}

test('dois processos dividem o mesmo limite pelo Redis', async () => {
  let t = 1_000
  const redis = new FakeRedis()
  const opts = { name: 'join', windowMs: 10_000, max: 3, getRedis: () => redis, now: () => t }
  const a = createRateLimiter(opts)
  const b = createRateLimiter(opts)
  assert.deepEqual([await hit(a), await hit(b), await hit(a), await hit(b)], [200, 200, 200, 429])
  assert.equal(await hit(a, '1.1.1.1'), 200, 'outro IP tem a própria cota')
  t += 10_000
  assert.equal(await hit(b), 200, 'janela nova zera')
})

test('sem Redis (dev) conta por processo', async () => {
  let t = 0
  const lim = createRateLimiter({ windowMs: 1000, max: 2, now: () => t })
  assert.deepEqual([await hit(lim), await hit(lim), await hit(lim)], [200, 200, 429])
  t += 1001
  assert.equal(await hit(lim), 200)
})

test('Redis com erro cai para a contagem local, sem liberar tudo nem bloquear todos', async () => {
  const redis = new FakeRedis(); redis.fail = true
  const lim = createRateLimiter({ windowMs: 10_000, max: 2, getRedis: () => redis, now: () => 0 })
  assert.deepEqual([await hit(lim), await hit(lim), await hit(lim)], [200, 200, 429])
})
