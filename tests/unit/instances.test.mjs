// tests/unit/instances.test.mjs
// Run: npm run test:unit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInstanceRegistry } from '../../src/lib/instances.js'

function setup(opts = {}) {
  let t = 1_000_000
  const clock = { now: () => t, advance: (ms) => { t += ms } }
  const reg = createInstanceRegistry({ now: clock.now, graceMs: 1000, maxPerIp: 2, maxPerTotem: 3, ...opts })
  return { reg, clock }
}

const conn = () => ({})

test('validId aceita ids seguros e recusa default/vazio/caracteres estranhos', () => {
  const { reg } = setup()
  assert.equal(reg.validId('a1-B_2'), true)
  assert.equal(reg.validId('default'), false)
  assert.equal(reg.validId(''), false)
  assert.equal(reg.validId('../x'), false)
  assert.equal(reg.validId('x'.repeat(65)), false)
})

test('attach com id inválido → 400', () => {
  const { reg } = setup()
  const r = reg.attach('t1', 'a b', conn(), '1.1.1.1')
  assert.equal(r.ok, false)
  assert.equal(r.code, 400)
})

test('attach cria instância online', () => {
  const { reg } = setup()
  const r = reg.attach('t1', 'a1', conn(), '1.1.1.1')
  assert.equal(r.ok, true)
  assert.equal(reg.get('t1', 'a1').id, 'a1')
  assert.equal(reg.isLive('t1', 'a1'), true)
  assert.deepEqual(reg.list('t1').map(i => [i.id, i.online]), [['a1', true]])
})

test('limite por IP → 429; reconexão de instância conhecida não conta', () => {
  const { reg } = setup()
  assert.equal(reg.attach('t1', 'a1', conn(), '1.1.1.1').ok, true)
  assert.equal(reg.attach('t1', 'a2', conn(), '1.1.1.1').ok, true)
  const third = reg.attach('t1', 'a3', conn(), '1.1.1.1')
  assert.equal(third.ok, false)
  assert.equal(third.code, 429)
  assert.equal(reg.attach('t1', 'a1', conn(), '1.1.1.1').ok, true, 'reconexão sempre permitida')
  assert.equal(reg.attach('t1', 'b1', conn(), '2.2.2.2').ok, true, 'outro IP passa')
})

test('loopback e IP nulo não são limitados por IP', () => {
  const { reg } = setup({ maxPerTotem: 100 })
  for (const id of ['l1', 'l2', 'l3', 'l4']) {
    assert.equal(reg.attach('t1', id, conn(), '127.0.0.1').ok, true)
  }
  assert.equal(reg.attach('t1', 'v6', conn(), '::ffff:127.0.0.1').ok, true)
  assert.equal(reg.attach('t1', 'n1', conn(), null).ok, true)
})

test('limite por totem → 429 (outro totem não é afetado)', () => {
  const { reg } = setup({ maxPerIp: 100 })
  for (const id of ['a', 'b', 'c']) assert.equal(reg.attach('t1', id, conn(), `9.9.9.${id.charCodeAt(0)}`).ok, true)
  const r = reg.attach('t1', 'd', conn(), '8.8.8.8')
  assert.equal(r.code, 429)
  assert.equal(reg.attach('t2', 'd', conn(), '8.8.8.8').ok, true)
})

test('detach de conexão antiga não derruba a instância reconectada', () => {
  const { reg } = setup()
  const old = conn(); const fresh = conn()
  reg.attach('t1', 'a1', old, '1.1.1.1')
  reg.attach('t1', 'a1', fresh, '1.1.1.1')
  reg.detach('t1', 'a1', old)
  assert.equal(reg.list('t1')[0].online, true)
  reg.detach('t1', 'a1', fresh)
  assert.equal(reg.list('t1')[0].online, false)
})

test('isLive respeita a folga; sweep remove só offline expiradas', () => {
  const { reg, clock } = setup({ maxPerIp: 100 })
  const c1 = conn()
  reg.attach('t1', 'gone', c1, '1.1.1.1')
  reg.attach('t1', 'here', conn(), '1.1.1.2')
  reg.detach('t1', 'gone', c1)

  clock.advance(500)
  assert.equal(reg.isLive('t1', 'gone'), true, 'dentro da folga')
  assert.deepEqual(reg.sweep(), [])

  clock.advance(600)
  assert.equal(reg.isLive('t1', 'gone'), false, 'fora da folga')
  assert.deepEqual(reg.sweep(), [{ totemId: 't1', id: 'gone' }])
  assert.equal(reg.get('t1', 'gone'), null)
  assert.equal(reg.isLive('t1', 'here'), true)
})

test('instância desconhecida não está viva; totals conta online', () => {
  const { reg } = setup({ maxPerIp: 100 })
  assert.equal(reg.isLive('t1', 'nope'), false)
  const c = conn()
  reg.attach('t1', 'a', c, '1.1.1.1')
  reg.attach('t2', 'b', conn(), '1.1.1.2')
  reg.detach('t1', 'a', c)
  assert.deepEqual(reg.totals(), { instances: 2, online: 1 })
})

test('remove apaga a instância na hora', () => {
  const { reg } = setup()
  reg.attach('t1', 'a', conn(), '1.1.1.1')
  reg.remove('t1', 'a')
  assert.equal(reg.get('t1', 'a'), null)
  assert.deepEqual(reg.list('t1'), [])
})
