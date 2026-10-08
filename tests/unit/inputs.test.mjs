// tests/unit/inputs.test.mjs — what a phone may send over /ws/game, and how fast.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyMessage, createTokenBucket } from '../../src/lib/inputs.js'

test('aceita só as 8 ações do gamepad com pressed/released', () => {
  assert.deepEqual(classifyMessage('{"action":"btn_A","state":"pressed"}'), { kind: 'input', action: 'btn_A', state: 'pressed' })
  assert.equal(classifyMessage(Buffer.from('{"action":"dpad_left","state":"released"}')).kind, 'input')
  assert.equal(classifyMessage('{"action":"btn_Z","state":"pressed"}').reason, 'unknown action')
  assert.equal(classifyMessage('{"action":"btn_A","state":1}').reason, 'unknown state')
  assert.equal(classifyMessage('{"action":"<script>","state":"pressed"}').kind, 'invalid')
})

test('ping do cliente é reconhecido; lixo é inválido', () => {
  assert.deepEqual(classifyMessage('{"type":"ping"}'), { kind: 'ping' })
  assert.equal(classifyMessage('nada').reason, 'not JSON')
  assert.equal(classifyMessage('null').reason, 'not an object')
  assert.equal(classifyMessage('[1]').kind, 'invalid')
})

test('token bucket: rajada até o limite, depois só a taxa sustentada', () => {
  let t = 0
  const take = createTokenBucket({ ratePerSec: 10, burst: 5, now: () => t })
  const burst = Array.from({ length: 8 }, () => take())
  assert.deepEqual(burst, [true, true, true, true, true, false, false, false])
  t += 100 // 0,1 s → 1 ficha
  assert.equal(take(), true)
  assert.equal(take(), false)
  t += 10_000
  assert.equal(Array.from({ length: 6 }, () => take()).filter(Boolean).length, 5, 'não acumula além do burst')
})
