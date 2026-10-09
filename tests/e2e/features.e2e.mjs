// tests/e2e/features.e2e.mjs
// Anonymous nicknames, ranking (score), pause, CSV export, event stats and the
// game settings schema, against the real server.
// Run: npm run test:e2e   (requires local MongoDB + Redis, same as dev)

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const PORT = 3106
const BASE = `http://localhost:${PORT}`
const PASSWORD = 'e2e-senha-recursos'

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
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const OP = { Authorization: `Bearer ${PASSWORD}` }
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`

// ── Boot server ───────────────────────────────────────────────────────────────
const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), OPERATOR_PASSWORD: PASSWORD, QUEUE_JOIN_RATE_MAX: '1000' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stderr.on('data', d => process.stderr.write(`[server] ${d}`))

for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`${BASE}/health`); if (r.ok) break } catch {}
  await sleep(250)
  if (i === 79) { console.error('Server did not boot'); process.exit(1) }
}

const created = []
async function newTotem(fields = {}) {
  const r = await j('POST', '/api/totems', { name: uid('Recursos'), ip: '127.0.0.1', udpPort: 19980, maxPlayers: 1, ...fields }, OP)
  assert.equal(r.status, 201, r.text)
  created.push(r.body._id)
  return r.body
}
const join = (t, playerId) => j('POST', `/api/totems/${t._id}/queue/join`, { playerId })
const status = (t, playerId) => j('GET', `/api/totems/${t._id}/queue/status?playerId=${playerId}`)
const key = (t) => ({ 'X-Totem-Key': t.gameKey })

// ── 1. Nicknames ─────────────────────────────────────────────────────────────
await scenario('apelido: cada jogador ganha um bicho + adjetivo, diferente dos outros da mesma tela', async () => {
  const t = await newTotem()
  const a = await join(t, uid('nk'))
  const b = await join(t, uid('nk'))
  assert.equal(a.body.status, 'play')
  assert.equal(b.body.status, 'queue')
  assert.match(a.body.nickname, /^\S+ \S+/)
  assert.match(b.body.nickname, /^\S+ \S+/)
  assert.notEqual(a.body.nickname, b.body.nickname)
  const session = await j('GET', `/api/sessions/${a.body.sessionId}`)
  assert.equal(session.body.nickname, a.body.nickname, 'a sessão guarda o apelido')
  const queued = await j('GET', `/api/totems/${t._id}/queue`, null, OP)
  assert.equal(queued.body.queue[0].nickname, b.body.nickname, 'o operador vê o apelido na fila')
})

await scenario('apelidos: listas editáveis só por admin, valem para as próximas entradas e voltam ao padrão', async () => {
  const before = await j('GET', '/api/settings/nicknames', null, OP)
  assert.equal(before.status, 200)
  assert.ok(before.body.animals.includes('Capivara'))
  assert.equal(before.body.examples.length, 6)
  assert.equal((await j('PUT', '/api/settings/nicknames', { animals: ['Tatu'], adjectives: [] }, OP)).status, 400)
  const put = await j('PUT', '/api/settings/nicknames', { animals: ['Tatu'], adjectives: ['Veloz'] }, OP)
  assert.equal(put.status, 200, put.text)
  const t = await newTotem({ maxPlayers: 3 })
  const n1 = (await join(t, uid('nk'))).body.nickname
  const n2 = (await join(t, uid('nk'))).body.nickname
  assert.equal(n1, 'Tatu Veloz')
  assert.match(n2, /^Tatu Veloz \d+$/, 'repetido na mesma tela ganha número')
  const reset = await j('PUT', '/api/settings/nicknames', { reset: true }, OP)
  assert.equal(reset.body.isDefault, true)
  assert.equal((await j('PUT', '/api/settings/nicknames', { reset: true })).status, 401)
})

// ── 2. Ranking ───────────────────────────────────────────────────────────────
await scenario('ranking: o jogo manda os pontos na morte; melhores primeiro, com apelido e totem', async () => {
  const t = await newTotem({ maxPlayers: 2 })
  const p1 = uid('rk'), p2 = uid('rk')
  const s1 = (await join(t, p1)).body
  const s2 = (await join(t, p2)).body
  assert.equal((await j('POST', `/api/totems/${t._id}/end-session`, { playerId: p1.slice(0, 8), score: 40 }, key(t))).status, 200)
  assert.equal((await j('POST', `/api/totems/${t._id}/end-session`, { playerId: p2, score: 120 }, key(t))).status, 200)
  assert.equal((await j('GET', `/api/totems/${t._id}/ranking`)).status, 401, 'ranking do totem exige operador ou chave')
  const board = await j('GET', `/api/totems/${t._id}/ranking?range=24h`, null, key(t))
  assert.equal(board.status, 200, board.text)
  assert.deepEqual(board.body.map(r => [r.position, r.nickname, r.score]), [[1, s2.nickname, 120], [2, s1.nickname, 40]])
  const event = await j('GET', '/api/ranking?range=24h&limit=50', null, OP)
  const row = event.body.find(r => r.totemId === t._id && r.score === 120)
  assert.equal(row?.totemName, t.name)
})

// ── 3. Pause ─────────────────────────────────────────────────────────────────
await scenario('pausa: entrada fechada (423), fila não anda; ao retomar, o próximo é chamado', async () => {
  const t = await newTotem()
  const p1 = uid('pz'), p2 = uid('pz')
  await join(t, p1)
  assert.equal((await join(t, p2)).body.status, 'queue')
  const pause = await j('POST', `/api/totems/${t._id}/pause`, { paused: true }, OP)
  assert.deepEqual(pause.body, { paused: true })
  assert.equal((await join(t, uid('pz'))).status, 423, 'ninguém novo entra')
  assert.equal((await status(t, p2)).body.paused, true, 'quem espera sabe da pausa')
  await j('POST', `/api/totems/${t._id}/end-session`, { playerId: p1 }, key(t))
  assert.equal((await status(t, p2)).body.status, 'queue', 'vaga livre não chama ninguém em pausa')
  await j('POST', `/api/totems/${t._id}/pause`, { paused: false }, OP)
  const after = await status(t, p2)
  assert.equal(after.body.status, 'play', 'retomar preenche a vaga')
  const totem = await j('GET', `/api/totems/${t._id}`, null, OP)
  assert.equal(totem.body.paused, false)
  assert.equal((await j('POST', `/api/totems/${t._id}/pause`, { paused: true })).status, 401)
})

// ── 4. CSV + event stats ─────────────────────────────────────────────────────
await scenario('planilha (CSV) do totem e do evento, e histórico do evento por totem', async () => {
  const t = await newTotem()
  const p = uid('csv')
  const s = (await join(t, p)).body
  await j('POST', `/api/totems/${t._id}/end-session`, { playerId: p, score: 77 }, key(t))
  assert.equal((await j('GET', `/api/totems/${t._id}/sessions.csv`)).status, 401)
  const csv = await j('GET', `/api/totems/${t._id}/sessions.csv?range=24h`, null, OP)
  assert.equal(csv.status, 200)
  assert.match(csv.headers.get('content-type'), /text\/csv/)
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="historico-/)
  const lines = csv.text.trim().split(/\r?\n/)
  assert.match(lines[0], /^totem;tela;site;jogador;/)
  assert.equal(lines.length, 2)
  assert.ok(lines[1].includes(s.nickname) && lines[1].endsWith(';77'), lines[1])
  const all = await j('GET', '/api/sessions.csv?range=24h', null, OP)
  assert.ok(all.text.includes(s.nickname))
  const stats = await j('GET', '/api/stats?range=24h', null, OP)
  assert.equal(stats.status, 200)
  const mine = stats.body.byTotem.find(x => x.totemId === t._id)
  assert.equal(mine?.sessions, 1)
  assert.ok(stats.body.totals.sessions >= 1)
})

// ── 5. Game settings form ────────────────────────────────────────────────────
await scenario('ajustes do jogo: o formulário vem do jogo e o servidor recusa valores fora da faixa', async () => {
  const schema = await j('GET', '/api/games/snake/config-schema', null, OP)
  assert.equal(schema.status, 200)
  assert.ok(schema.body.fields.some(f => f.key === 'gameSpeed'))
  assert.equal((await j('GET', '/api/games/nao-existe/config-schema', null, OP)).status, 404)
  const t = await newTotem({ game: 'brick-rush' })
  const bad = await j('PUT', `/api/totems/${t._id}`, { gameConfig: { roundMs: 5000 } }, OP)
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /mínimo 20 s/)
  const ok = await j('PUT', `/api/totems/${t._id}`, { gameConfig: { roundMs: 60000, extra: 'x' } }, OP)
  assert.equal(ok.status, 204, ok.text)
  const saved = await j('GET', `/api/totems/${t._id}`, null, OP)
  assert.deepEqual(saved.body.gameConfig, { roundMs: 60000, extra: 'x' })
})

// ── Cleanup ──────────────────────────────────────────────────────────────────
for (const id of created) await j('DELETE', `/api/totems/${id}`, null, OP)
server.kill()
console.log(failures === 0 ? '\nALL SCENARIOS PASSED' : `\n${failures} SCENARIO(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
