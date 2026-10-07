// tests/e2e/instances.e2e.mjs
// End-to-end verification of n→n: one totem embedded as many iframes, each
// iframe an isolated instance (own queue, sessions, SSE packet stream).
// Spawns the real server (isolated port) and exercises the full flow.
// Run: npm run test:e2e   (requires local MongoDB + Redis, same as dev)

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const PORT = 3101
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

async function j(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function makeTotem(overrides = {}) {
  const r = await j('POST', '/api/totems', {
    name: `e2e-inst-${Math.random().toString(36).slice(2, 8)}`,
    game: 'snake', maxPlayers: 1, ...overrides,
  })
  assert.equal(r.status, 201, `create totem -> ${r.status} ${r.text}`)
  return r.body._id
}

/** Opens an instance SSE stream and collects parsed packets. */
async function openStream(totemId, instanceId, headers = {}) {
  const ctrl = new AbortController()
  const res = await fetch(`${BASE}/embed/${totemId}/${instanceId}/events`, { signal: ctrl.signal, headers })
  const stream = { status: res.status, packets: [], close: () => ctrl.abort() }
  if (res.status !== 200) { await res.text().catch(() => {}); return stream }
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
    } catch { /* aborted */ }
  })()
  await sleep(150)
  return stream
}

function wsConnect(sessionId, playerId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/game?sessionId=${sessionId}&playerId=${playerId}`)
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 3000)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onclose = (e) => { clearTimeout(timer); reject(new Error(`WS closed: ${e.code} ${e.reason}`)) }
  })
}

const join = (tid, inst, playerId) =>
  j('POST', `/api/totems/${tid}/queue/join?instance=${inst}`, { playerId })

// ── Boot server ───────────────────────────────────────────────────────────────
const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT), OPERATOR_PASSWORD: '',
    QUEUE_RESERVE_MS: '5000', QUEUE_SWEEP_MS: '500', QUEUE_JOIN_RATE_MAX: '1000',
    INSTANCE_GRACE_MS: '1500', MAX_INSTANCES_PER_IP: '3', TRUST_PROXY: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', d => process.stderr.write(`[server] ${d}`))

for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`${BASE}/health`); if (r.ok) break } catch {}
  await sleep(250)
  if (i === 79) { console.error('Server did not boot'); process.exit(1) }
}

const createdTotems = []
const streams = []
// Every stream gets its own fake visitor IP so the per-IP limit only bites in scenario 7.
let ipSeq = 10
const visitor = () => ({ 'X-Forwarded-For': `203.0.113.${ipSeq++}` })

// ── 1. Entry redirect ─────────────────────────────────────────────────────────
await scenario('/embed/:id redireciona para uma instância NOVA a cada carregamento', async () => {
  const tid = await makeTotem(); createdTotems.push(tid)
  const a = await j('GET', `/embed/${tid}?showqr=false`)
  const b = await j('GET', `/embed/${tid}`)
  assert.equal(a.status, 302)
  const re = new RegExp(`^/embed/${tid}/([A-Za-z0-9-]+)/`)
  const ia = a.headers.get('location').match(re)?.[1]
  const ib = b.headers.get('location').match(re)?.[1]
  assert.ok(ia && ib, `bad location ${a.headers.get('location')}`)
  assert.notEqual(ia, ib)
  assert.ok(a.headers.get('location').endsWith('?showqr=false'), 'query preservada')

  const phys = await j('POST', '/api/totems', { name: 'e2e-phys', ip: '127.0.0.1', udpPort: 19999 })
  createdTotems.push(phys.body._id)
  const none = await j('GET', `/embed/${phys.body._id}`)
  assert.equal(none.status, 404, 'totem sem jogo não é incorporável')
})

// ── 2. Game page + static files ───────────────────────────────────────────────
await scenario('página da instância injeta o overlay; estáticos servidos; traversal bloqueado', async () => {
  const tid = await makeTotem(); createdTotems.push(tid)
  const page = await j('GET', `/embed/${tid}/pg1/`)
  assert.equal(page.status, 200)
  assert.match(page.text, /\/embed-assets\/overlay\.js/)
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors/)
  const js = await j('GET', `/embed/${tid}/pg1/game.js`)
  assert.equal(js.status, 200)
  const cfg = await j('GET', `/embed/${tid}/pg1/config`)
  assert.equal(cfg.body.debugPanel, false)
  const trav = await j('GET', `/embed/${tid}/pg1/..%2F..%2F..%2Fpackage.json`)
  assert.notEqual(trav.status, 200, 'path traversal deve falhar')
  assert.doesNotMatch(trav.text, /"fastify"/)
})

// ── 3. Independent slots ──────────────────────────────────────────────────────
await scenario('duas instâncias do mesmo totem têm vagas e filas independentes', async () => {
  const tid = await makeTotem({ maxPlayers: 1 }); createdTotems.push(tid)
  const sA = await openStream(tid, 'slotA', visitor()); streams.push(sA)
  const sB = await openStream(tid, 'slotB', visitor()); streams.push(sB)
  assert.equal(sA.status, 200)
  assert.ok(sA.packets.some(p => p.type === 'init' && p.instanceId === 'slotA'), 'init com instanceId')

  const a1 = await join(tid, 'slotA', 'e2e_ia1')
  const b1 = await join(tid, 'slotB', 'e2e_ib1')
  const a2 = await join(tid, 'slotA', 'e2e_ia2')
  assert.equal(a1.body.status, 'play')
  assert.equal(b1.body.status, 'play', 'B tem vaga própria')
  assert.equal(a2.body.status, 'queue')
  assert.equal(a2.body.position, 1)

  const viewA = await j('GET', `/api/totems/${tid}/queue?instance=slotA`)
  assert.equal(viewA.body.sessions.length, 1)
  assert.equal(viewA.body.queue.length, 1)
  const insts = await j('GET', `/api/totems/${tid}/instances`)
  assert.deepEqual(insts.body.map(i => i.id).sort(), ['default', 'slotA', 'slotB'])
})

// ── 4. Packet routing ─────────────────────────────────────────────────────────
await scenario('player_join e inputs chegam SÓ no SSE da instância do jogador', async () => {
  const tid = await makeTotem({ maxPlayers: 1 }); createdTotems.push(tid)
  const sA = await openStream(tid, 'rtA', visitor()); streams.push(sA)
  const sB = await openStream(tid, 'rtB', visitor()); streams.push(sB)
  const a = await join(tid, 'rtA', 'e2e_rta')
  const ws = await wsConnect(a.body.sessionId, 'e2e_rta')
  await sleep(300)
  ws.send(JSON.stringify({ action: 'btn_A', state: 'pressed' }))
  await sleep(500)

  assert.ok(sA.packets.some(p => p.type === 'player_join' && p.pid === 'e2e_rta'), 'player_join em A')
  assert.ok(sA.packets.some(p => p.a === 'btn_A' && p.s === 1 && p.pid === 'e2e_rta'), 'input em A')
  assert.ok(!sB.packets.some(p => p.pid === 'e2e_rta'), 'nada vaza para B')
  ws.close()
})

// ── 5. Death via the embed endpoint ──────────────────────────────────────────
await scenario('end-session da instância encerra a sessão (died), envia player_leave e chama o próximo', async () => {
  const tid = await makeTotem({ maxPlayers: 1 }); createdTotems.push(tid)
  const s = await openStream(tid, 'dthA', visitor()); streams.push(s)
  const p1 = await join(tid, 'dthA', 'e2e_dt1')
  const p2 = await join(tid, 'dthA', 'e2e_dt2')
  assert.equal(p2.body.status, 'queue')

  const died = await j('POST', `/embed/${tid}/dthA/end-session`, { pid: 'e2e_dt1'.slice(0, 8) })
  assert.equal(died.status, 200, died.text)
  const s1 = await j('GET', `/api/sessions/${p1.body.sessionId}`)
  assert.equal(s1.body.status, 'finished')
  assert.equal(s1.body.endReason, 'died')
  assert.equal(s1.body.instanceId, 'dthA')
  await sleep(200)
  assert.ok(s.packets.some(p => p.type === 'player_leave' && p.pid === 'e2e_dt1'), 'player_leave no SSE')

  const st2 = await j('GET', `/api/totems/${tid}/queue/status?playerId=e2e_dt2&instance=dthA`)
  assert.equal(st2.body.status, 'play')
})

// ── 6. Closed iframe ─────────────────────────────────────────────────────────
await scenario('iframe fechado: após a folga sessões viram instance_closed e join → 410', async () => {
  const tid = await makeTotem({ maxPlayers: 1 }); createdTotems.push(tid)
  const s = await openStream(tid, 'gone1', visitor())
  const p1 = await join(tid, 'gone1', 'e2e_gn1')
  assert.equal(p1.body.status, 'play')
  s.close()

  await sleep(2800) // grace 1500 + sweep 500 + folga
  const s1 = await j('GET', `/api/sessions/${p1.body.sessionId}`)
  assert.equal(s1.body.status, 'finished')
  assert.equal(s1.body.endReason, 'instance_closed')
  const again = await join(tid, 'gone1', 'e2e_gn2')
  assert.equal(again.status, 410)
  const never = await join(tid, 'never-opened', 'e2e_gn3')
  assert.equal(never.status, 410, 'instância nunca aberta também é 410')
})

// ── 7. Per-IP limit ───────────────────────────────────────────────────────────
await scenario('limite de telas por IP → 429 (reconexão continua permitida)', async () => {
  const tid = await makeTotem(); createdTotems.push(tid)
  const ip = { 'X-Forwarded-For': '198.51.100.7' }
  for (const id of ['lim1', 'lim2', 'lim3']) {
    const s = await openStream(tid, id, ip); streams.push(s)
    assert.equal(s.status, 200, `${id} deveria abrir`)
  }
  const fourth = await openStream(tid, 'lim4', ip); streams.push(fourth)
  assert.equal(fourth.status, 429)
  const again = await openStream(tid, 'lim1', ip); streams.push(again)
  assert.equal(again.status, 200, 'reconectar instância conhecida é permitido')
})

// ── 8. Default instance untouched ────────────────────────────────────────────
await scenario('instância default (totem físico) não enxerga as filas das instâncias web', async () => {
  const tid = await makeTotem({ maxPlayers: 1, ip: '127.0.0.1', udpPort: 19999 }); createdTotems.push(tid)
  const s = await openStream(tid, 'mixA', visitor()); streams.push(s)
  const w = await join(tid, 'mixA', 'e2e_mx1')
  const d = await j('POST', `/api/totems/${tid}/queue/join`, { playerId: 'e2e_mx2' })
  assert.equal(w.body.status, 'play')
  assert.equal(d.body.status, 'play', 'default tem vaga própria')
  const sd = await j('GET', `/api/sessions/${d.body.sessionId}`)
  assert.equal(sd.body.instanceId, 'default')
})

// ── Cleanup ──────────────────────────────────────────────────────────────────
for (const s of streams) s.close()
for (const tid of createdTotems) await j('DELETE', `/api/totems/${tid}`)
server.kill()
console.log(failures === 0 ? '\nALL SCENARIOS PASSED' : `\n${failures} SCENARIO(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
