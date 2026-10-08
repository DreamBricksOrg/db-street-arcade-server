// tests/unit/auth.test.mjs — operator cookie signing + helpers (fake clock).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOperatorAuth, parseCookies, safeEqual, newTotemKey } from '../../src/lib/auth.js'

test('sem senha: auth desligado e nada verifica', () => {
  const auth = createOperatorAuth({ password: '' })
  assert.equal(auth.enabled, false)
  assert.equal(auth.verify('123.YQ.abc'), null)
  assert.equal(auth.checkPassword(''), false)
})

test('cookie emitido carrega o usuário e vale até expirar', () => {
  let t = 1_000
  const auth = createOperatorAuth({ password: 's3nha', ttlMs: 500, now: () => t })
  const token = auth.issue('u-123:4')
  assert.equal(auth.verify(token), 'u-123:4')
  assert.equal(auth.verify(auth.issue()), 'admin', 'padrão: admin de emergência')
  t = 1_500
  assert.equal(auth.verify(token), 'u-123:4', 'no limite ainda vale')
  t = 1_501
  assert.equal(auth.verify(token), null, 'expirado')
})

test('cookie adulterado, de outra senha ou com outro usuário é rejeitado', () => {
  const now = () => 0
  const a = createOperatorAuth({ password: 'um', now })
  const b = createOperatorAuth({ password: 'dois', now })
  const token = a.issue('u-1:1')
  assert.equal(b.verify(token), null, 'trocar OPERATOR_PASSWORD derruba as sessões')
  const [exp, sub, sig] = token.split('.')
  assert.equal(a.verify(`${Number(exp) + 1}.${sub}.${sig}`), null, 'expiração alterada')
  assert.equal(a.verify(`${exp}.${Buffer.from('admin').toString('base64url')}.${sig}`), null, 'trocar o usuário invalida a assinatura')
  assert.equal(a.verify(`${exp}.${sub}.${sig.slice(0, -1)}x`), null, 'assinatura alterada')
  assert.equal(a.verify('lixo'), null)
  assert.equal(a.verify(undefined), null)
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

test('canonicalPath resolve o que o roteador resolve (sem desvio por codificação)', async () => {
  const { canonicalPath } = await import('../../src/lib/auth.js')
  for (const p of ['/index.html', '//index.html', '/./index.html', '/%2Findex.html', '/index%2Ehtml', '/x/../index.html', '/%2e/index.html', '/\\index.html']) {
    assert.equal(canonicalPath(p), '/index.html', p)
  }
  assert.equal(canonicalPath('/%64ocumentation/json?x=1'), '/documentation/json')
  assert.equal(canonicalPath('/%E0%A4%A'), null, 'codificação inválida')
  assert.equal(canonicalPath('/a%00b'), null, 'byte nulo')
})
