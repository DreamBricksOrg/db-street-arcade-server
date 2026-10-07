// tests/e2e/cluster.e2e.mjs
// Two backend processes on the same MongoDB + Redis (two replicas behind a
// load balancer), plus a restart in the middle of a game. Proves:
//   - an iframe on process A gets inputs from a phone connected to B, once
//   - instances are visible from any process
//   - restarting the process that held the iframe drops nobody
// Run: npm run test:e2e   (requires local MongoDB + Redis, same as dev)

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const A = 3103
const B = 3104
const GRACE = 6000

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function j(port, method, url, body) {
  const res = await fetch(`http://localhost:${port}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body: json, text }
}

function boot(port) {
  const proc = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(port), OPERATOR_PASSWORD: '',
      QUEUE_RESERVE_MS: '20000', QUEUE_SWEEP_MS: '500', QUEUE_JOIN_RATE_MAX: '1000',
      INSTANCE_GRACE_MS: String(GRACE),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stderr.on('data', d => process.stderr.write(`[${port}] ${d}`))
  return proc
}

async function waitUp(port) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://localhost:${port}/health`)).ok) return } catch {}
    await sleep(250)
  }
  throw new Error(`server ${port} did not boot`)
}

async function openStream(port, totemId, instanceId) {
  const ctrl = new AbortController()
  const res = await fetch(`http://localhost:${port}/embed/${totemId}/${instanceId}/events`, { signal: ctrl.signal })
  const stream = { status: res.status, packets: [], close: () => ctrl.abort() }
  ;(async () => {
    const dec = new TextDecoder()
    let buf = ''
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2)
          const line = frame.split('\n').find(l => l.startsWith('data: '))
          if (line) { try { stream.packets.push(JSON.parse(line.slice(6))) } catch { /* ignore */ } }
        }
      }
    } catch { /* aborted / server died */ }
  })()
  await sleep(200)
  return stream
}

function wsConnect(port, sessionId, playerId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/game?sessionId=${sessionId}&playerId=${playerId}`)
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 3000)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onclose = (e) => { clearTimeout(timer); reject(new Error(`WS closed: ${e.code} ${e.reason}`)) }
  })
}

let procA = boot(A)
const procB = boot(B)
await Promise.all([waitUp(A), waitUp(B)])

const totem = await j(A, 'POST', '/api/totems', { name: 'e2e-cluster', game: 'snake', maxPlayers: 2 })
const tid = totem.body._id
let streamA = null
let session = null

// ── 1. Cross-process delivery ────────────────────────────────────────────────
await scenario('iframe no processo A recebe, uma vez só, o input de um celular ligado no B', async () => {
  streamA = await openStream(A, tid, 'clA')
  assert.equal(streamA.status, 200)
  const join = await j(B, 'POST', `/api/totems/${tid}/queue/join?instance=clA`, { playerId: 'e2e_cl1' })
  assert.equal(join.body.status, 'play', join.text)
  session = join.body.sessionId

  const ws = await wsConnect(B, session, 'e2e_cl1')
  await sleep(300)
  ws.send(JSON.stringify({ action: 'btn_A', state: 'pressed' }))
  await sleep(600)
  ws.close()

  assert.ok(streamA.packets.some(p => p.type === 'player_join' && p.pid === 'e2e_cl1'), 'player_join chegou em A')
  const presses = streamA.packets.filter(p => p.a === 'btn_A' && p.pid === 'e2e_cl1')
  assert.equal(presses.length, 1, `input deveria chegar 1x, chegou ${presses.length}x`)
})

// ── 2. Shared registry ───────────────────────────────────────────────────────
await scenario('a instância aberta no A aparece no B como online', async () => {
  const rows = await j(B, 'GET', `/api/totems/${tid}/instances`)
  const row = rows.body.find(r => r.id === 'clA')
  assert.ok(row, 'B conhece a instância')
  assert.equal(row.online, true)
  assert.equal(row.sessions, 1)
})

// ── 3. Restart without dropping ──────────────────────────────────────────────
await scenario('reiniciar o processo do iframe não derruba a partida', async () => {
  procA.kill()
  streamA.close()
  await sleep(800)
  const during = await j(B, 'POST', `/api/totems/${tid}/queue/join?instance=clA`, { playerId: 'e2e_cl2' })
  assert.notEqual(during.status, 410, 'instância segue viva durante o restart')

  procA = boot(A)
  await waitUp(A)
  streamA = await openStream(A, tid, 'clA')  // o EventSource do iframe reconecta
  await sleep(GRACE + 1500)                  // passa da folga inteira

  const s = await j(B, 'GET', `/api/sessions/${session}`)
  assert.equal(s.body.status, 'active', `sessão deveria seguir ativa, está ${s.body.status}/${s.body.endReason}`)

  const died = await j(B, 'POST', `/embed/${tid}/clA/end-session`, { pid: 'e2e_cl1' })
  assert.equal(died.status, 200, died.text)
  await sleep(400)
  assert.ok(streamA.packets.some(p => p.type === 'player_leave' && p.pid === 'e2e_cl1'), 'player_leave no stream novo')
})

// ── Cleanup ──────────────────────────────────────────────────────────────────
streamA?.close()
await j(B, 'DELETE', `/api/totems/${tid}`)
procA.kill()
procB.kill()
console.log(failures === 0 ? '\nALL SCENARIOS PASSED' : `\n${failures} SCENARIO(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
