// tests/unit/passwords.test.mjs — scrypt account passwords.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, passwordProblem } from '../../src/lib/passwords.js'

test('hash confere só com a senha certa e usa sal diferente a cada vez', async () => {
  const h1 = await hashPassword('senha-boa-123')
  const h2 = await hashPassword('senha-boa-123')
  assert.match(h1, /^scrypt\$16384\$[\w-]+\$[\w-]+$/)
  assert.notEqual(h1, h2)
  assert.equal(await verifyPassword('senha-boa-123', h1), true)
  assert.equal(await verifyPassword('senha-boa-124', h1), false)
  assert.equal(await verifyPassword('x', 'lixo'), false)
  assert.equal(await verifyPassword('x', null), false)
})

test('regra mínima de senha', () => {
  assert.match(passwordProblem('curta'), /10 caracteres/)
  assert.equal(passwordProblem('uma-senha-ok'), null)
})
