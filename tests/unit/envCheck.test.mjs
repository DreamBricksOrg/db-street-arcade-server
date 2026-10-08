// tests/unit/envCheck.test.mjs — production readiness rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkProductionEnv } from '../../src/lib/envCheck.js'

const good = {
  NODE_ENV: 'production', MONGO_URI: 'mongodb://mongo/x', REDIS_URL: 'redis://redis', UDP_HOST: '127.0.0.1', UDP_PORT: '9001',
  OPERATOR_PASSWORD: 'a-very-long-random-pass', PUBLIC_URL: 'https://arcade.exemplo.com', TRUST_PROXY: 'true',
  EMBED_FRAME_ANCESTORS: 'https://loja.exemplo.com', SESSION_RETENTION_DAYS: '90',
}

test('configuração completa de produção não tem erros nem avisos', () => {
  assert.deepEqual(checkProductionEnv(good), { errors: [], warnings: [] })
})

test('erros: senha ausente, valores de exemplo, obrigatórias vazias', () => {
  const r = checkProductionEnv({ ...good, OPERATOR_PASSWORD: '', PUBLIC_URL: 'https://<seu-dominio>', REDIS_URL: '' })
  assert.equal(r.errors.length, 3)
  assert.ok(r.errors.some(e => e.includes('OPERATOR_PASSWORD')))
  assert.ok(r.errors.some(e => e.includes('PUBLIC_URL')))
  assert.ok(r.errors.some(e => e.includes('REDIS_URL')))
  assert.ok(checkProductionEnv({ ...good, OPERATOR_PASSWORD: '<senha-longa-aleatória>' }).errors.length === 1)
})

test('avisos: senha curta, http, proxy desligado, qualquer site, retenção curta', () => {
  const r = checkProductionEnv({
    ...good, OPERATOR_PASSWORD: 'curta', PUBLIC_URL: 'http://arcade.exemplo.com',
    TRUST_PROXY: 'false', EMBED_FRAME_ANCESTORS: '*', SESSION_RETENTION_DAYS: '7',
  })
  assert.equal(r.errors.length, 0)
  assert.equal(r.warnings.length, 5)
  assert.equal(checkProductionEnv({ ...good, SESSION_RETENTION_DAYS: 'x' }).errors.length, 1)
})
