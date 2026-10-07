// tests/unit/auth.test.mjs — operator cookie signing + helpers (fake clock).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOperatorAuth, parseCookies, safeEqual, newTotemKey } from '../../src/lib/auth.js'

test('sem senha: auth desligado e nada verifica', () => {
  const auth = createOperatorAuth({ password: '' })
  assert.equal(auth.enabled, false)
  assert.equal(auth.verify('123.abc'), false)
  assert.equal(auth.checkPassword(''), false)
})

test('cookie emitido verifica até expirar', () => {
  let t = 1_000
  const auth = createOperatorAuth({ password: 's3nha', ttlMs: 500, now: () => t })
  const token = auth.issue()
  assert.equal(auth.verify(token), true)
  t = 1_500
  assert.equal(auth.verify(token), true, 'no limite ainda vale')
  t = 1_501
  assert.equal(auth.verify(token), false, 'expirado')
})

test('cookie adulterado ou de outra senha é rejeitado', () => {
  const now = () => 0
  const a = createOperatorAuth({ password: 'um', now })
  const b = createOperatorAuth({ password: 'dois', now })
  const token = a.issue()
  assert.equal(b.verify(token), false, 'trocar a senha derruba as sessões')
  const [exp, sig] = token.split('.')
  assert.equal(a.verify(`${Number(exp) + 1}.${sig}`), false, 'expiração alterada')
  assert.equal(a.verify(`${exp}.${sig.slice(0, -1)}x`), false, 'assinatura alterada')
  assert.equal(a.verify('lixo'), false)
  assert.equal(a.verify(undefined), false)
})

test('checkPassword compara a senha exata', () => {
  const auth = createOperatorAuth({ password: 'abc' })
  assert.equal(auth.checkPassword('abc'), true)
  assert.equal(auth.checkPassword('abcd'), false)
  assert.equal(auth.checkPassword(null), false)
})

test('parseCookies e safeEqual', () => {
  assert.deepEqual(parseCookies('a=1; sa_op=9.x%2By; b'), { a: '1', sa_op: '9.x+y' })
  assert.deepEqual(parseCookies(undefined), {})
  assert.equal(safeEqual('x', 'x'), true)
  assert.equal(safeEqual('x', 'xy'), false)
  assert.equal(safeEqual(undefined, 'x'), false)
})

test('newTotemKey gera chaves distintas, url-safe', () => {
  const a = newTotemKey(), b = newTotemKey()
  assert.notEqual(a, b)
  assert.match(a, /^[A-Za-z0-9_-]{24}$/)
})
