// tests/e2e/queue.e2e.mjs
// End-to-end verification of the per-player-session queue model.
// Spawns the real server (isolated port) and exercises the full flow.
// Run: npm run test:e2e   (requires local MongoDB + Redis, same as dev)

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const PORT = 3100
const BASE = `http://localhost:${PORT}`

let failures = 0
async function scenario(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL  ${name}\n      ${err.message}`)
  }
}

async function j(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function makeTotem(overrides = {}) {
  const r = await j('POST', '/api/totems', {
    name: `e2e-${Math.random().toString(36).slice(2, 8)}`,
    ip: '127.0.0.1', udpPort: 19999, maxPlayers: 2, ...overrides,
  })
  assert.equal(r.status, 201, `create totem -> ${r.status}`)
  return r.body._id
}

function wsConnect(sessionId, playerId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/game?sessionId=${sessionId}&playerId=${playerId}`)
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 3000)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onclose = (e) => { clearTimeout(timer); reject(new Error(`WS closed: ${e.code} ${e.reason}`)) }
  })
}

// ── Boot server ───────────────────────────────────────────────────────────────
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), QUEUE_RESERVE_MS: '2000', QUEUE_SWEEP_MS: '500', QUEUE_JOIN_RATE_MAX: '1000' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', d => process.stderr.write(`[server] ${d}`))

for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`${BASE}/health`); if (r.ok) break } catch {}
  await sleep(250)
  if (i === 39) { console.error('Server did not boot'); process.exit(1) }
}

const createdTotems = []

// ── Scenario 1: concurrent joins → distinct sessions, correct occupancy ──────
await scenario('3 joins simultâneos em totem de 2 vagas → 2 sessões DISTINTAS + 1 na fila', async () => {
  const tid = await makeTotem({ maxPlayers: 2 }); createdTotems.push(tid)
  const [a, b, c] = await Promise.all([
    j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_p1' }),
    j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_p2' }),
    j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_p3' }),
  ])
  const plays  = [a, b, c].filter(r => r.body?.status === 'play')
  const queued = [a, b, c].filter(r => r.body?.status === 'queue')
  assert.equal(plays.length, 2, `expected 2 play, got ${plays.length}`)
  assert.equal(queued.length, 1, `expected 1 queue, got ${queued.length}`)
  const sids = new Set(plays.map(r => r.body.sessionId))
  assert.equal(sids.size, 2, `sessionIds must be DISTINCT, got ${[...sids]}`)
  assert.equal(queued[0].body.position, 1)
})

// ── Scenario 2: reconnect idempotente ────────────────────────────────────────
await scenario('join repetido do mesmo jogador devolve a MESMA sessão', async () => {
  const tid = await makeTotem({ maxPlayers: 1 }); createdTotems.push(tid)
  const r1 = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_re' })
  const r2 = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_re' })
  assert.equal(r1.body.status, 'play')
  assert.equal(r2.body.status, 'play')
  assert.equal(r1.body.sessionId, r2.body.sessionId)
})

// ── Scenario 3: WS claim → active ────────────────────────────────────────────
await scenario('WS connect reivindica a sessão (reserved → active)', async () => {
  const tid = await makeTotem({ maxPlayers: 1 }); createdTotems.push(tid)
  const r = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_ws' })
  const ws = await wsConnect(r.body.sessionId, 'e2e_ws')
  await sleep(300)
  const s = await j('GET', `/api/sessions/${r.body.sessionId}`)
  assert.equal(s.body.status, 'active')
  ws.close()
})

// ── Scenario 4: morte → sessão encerra → fila anda ───────────────────────────
await scenario('morte encerra SÓ a sessão do morto e chama o próximo da fila', async () => {
  const tid = await makeTotem({ maxPlayers: 2 }); createdTotems.push(tid)
  const p1 = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_d1' })
  const p2 = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_d2' })
  const p3 = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_d3' })
  assert.equal(p3.body.status, 'queue')

  // p1 morre — o jogo só conhece o pid truncado de 8 chars
  const died = await j('POST', `/api/totems/${tid}/end-session`, { playerId: 'e2e_d1'.slice(0, 8) })
  assert.equal(died.status, 200)

  const s1 = await j('GET', `/api/sessions/${p1.body.sessionId}`)
  assert.equal(s1.body.status, 'finished')
  const s2 = await j('GET', `/api/sessions/${p2.body.sessionId}`)
  assert.notEqual(s2.body.status, 'finished', 'p2 não pode ser afetado')

  const st3 = await j('GET', `/api/totems/${tid}/queue/status?playerId=e2e_d3`)
  assert.equal(st3.body.status, 'play', 'p3 deveria ter sido chamado')
  assert.notEqual(st3.body.sessionId, p1.body.sessionId, 'sessão de p3 deve ser NOVA')
})

// ── Scenario 5: no_show 30s (2s no teste) → pula pro próximo ─────────────────
await scenario('reserva não reclamada expira e a vaga passa pro próximo', async () => {
  const tid = await makeTotem({ maxPlayers: 1 }); createdTotems.push(tid)
  const p1 = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_n1' })
  assert.equal(p1.body.status, 'play') // reserved, nunca conecta
  const p2 = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_n2' })
  assert.equal(p2.body.status, 'queue')

  await sleep(3500) // reserve 2000ms + sweep 500ms + folga

  const s1 = await j('GET', `/api/sessions/${p1.body.sessionId}`)
  assert.equal(s1.body.status, 'finished')
  assert.equal(s1.body.endReason, 'no_show')
  const st2 = await j('GET', `/api/totems/${tid}/queue/status?playerId=e2e_n2`)
  assert.equal(st2.body.status, 'play')
})

// ── Scenario 6: maxQueueSize → 409 ───────────────────────────────────────────
await scenario('fila cheia devolve 409', async () => {
  const tid = await makeTotem({ maxPlayers: 1, maxQueueSize: 1 }); createdTotems.push(tid)
  await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_f1' })
  const q1 = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_f2' })
  assert.equal(q1.body.status, 'queue')
  const full = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_f3' })
  assert.equal(full.status, 409)
})

// ── Scenario 7: kick da fila + clear ─────────────────────────────────────────
await scenario('kick remove da fila; clear esvazia sem derrubar sessões', async () => {
  const tid = await makeTotem({ maxPlayers: 1 }); createdTotems.push(tid)
  const p1 = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_k1' })
  await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_k2' })
  await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_k3' })

  await j('DELETE', `/api/totems/${tid}/queue/e2e_k2`)
  const st3 = await j('GET', `/api/totems/${tid}/queue/status?playerId=e2e_k3`)
  assert.equal(st3.body.position, 1, 'k3 sobe pra posição 1 após kick de k2')

  await j('POST', `/api/totems/${tid}/queue/clear`)
  const view = await j('GET', `/api/totems/${tid}/queue`)
  assert.equal(view.body.queue.length, 0)
  const s1 = await j('GET', `/api/sessions/${p1.body.sessionId}`)
  assert.notEqual(s1.body.status, 'finished', 'clear NÃO derruba sessão ativa')
})

// ── Scenario 8: kick de jogador jogando encerra a sessão dele ────────────────
await scenario('kick de sessão encerra e fila anda', async () => {
  const tid = await makeTotem({ maxPlayers: 1 }); createdTotems.push(tid)
  const p1 = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_x1' })
  await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_x2' })
  const kick = await j('POST', `/api/sessions/${p1.body.sessionId}/players/e2e_x1/kick`)
  assert.equal(kick.status, 200)
  const s1 = await j('GET', `/api/sessions/${p1.body.sessionId}`)
  assert.equal(s1.body.status, 'finished')
  assert.equal(s1.body.endReason, 'kicked')
  const st2 = await j('GET', `/api/totems/${tid}/queue/status?playerId=e2e_x2`)
  assert.equal(st2.body.status, 'play')
})

// ── Cleanup ──────────────────────────────────────────────────────────────────
for (const tid of createdTotems) await j('DELETE', `/api/totems/${tid}`)
server.kill()
console.log(failures === 0 ? '\nALL SCENARIOS PASSED' : `\n${failures} SCENARIO(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
