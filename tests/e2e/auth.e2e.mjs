// tests/e2e/auth.e2e.mjs
// Operator login + totem key, against the real server with OPERATOR_PASSWORD.
// Run: npm run test:e2e   (requires local MongoDB + Redis, same as dev)

import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { MongoClient } from 'mongodb'

const PORT = 3102
const BASE = `http://localhost:${PORT}`
const PASSWORD = 'e2e-senha-operador'

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
const BEARER = { Authorization: `Bearer ${PASSWORD}` }

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
let cookie = null

// ── 1. Locked by default ─────────────────────────────────────────────────────
await scenario('sem login: API de operação 401, painel redireciona para /login', async () => {
  assert.equal((await j('GET', '/api/totems')).status, 401)
  assert.equal((await j('POST', '/api/totems', { name: 'x', game: 'snake' })).status, 401)
  assert.equal((await j('GET', '/api/sessions')).status, 401)
  assert.equal((await j('GET', '/api/operator/events')).status, 401, 'stream do painel exige login')
  const home = await j('GET', '/')
  assert.equal(home.status, 302)
  assert.equal(home.headers.get('location'), '/login')
  assert.equal((await j('GET', '/login')).status, 200)
  for (const p of ['/index.html', '//index.html', '/index%2Ehtml', '/%2Findex.html', '/x/../index.html']) {
    const r = await j('GET', p)
    assert.ok(r.status >= 300 && !r.text.includes('totem-list'), `${p} não pode entregar o painel (${r.status})`)
  }
  assert.deepEqual((await j('GET', '/api/auth/me')).body, { operator: false, authEnabled: true })
})

// ── 2. Login ─────────────────────────────────────────────────────────────────
await scenario('login: senha errada 401; certa grava cookie HttpOnly que libera a API', async () => {
  assert.equal((await j('POST', '/api/auth/login', { password: 'errada' })).status, 401)
  const ok = await j('POST', '/api/auth/login', { password: PASSWORD })
  assert.equal(ok.status, 200)
  const setCookie = ok.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /^sa_op=\d+\.[\w-]+;/)
  assert.match(setCookie, /HttpOnly/)
  cookie = setCookie.split(';')[0]
  assert.equal((await j('GET', '/api/totems', null, { cookie })).status, 200)
  assert.equal((await j('GET', '/', null, { cookie })).status, 200, 'painel abre logado')
  assert.equal((await j('GET', '/api/totems', null, BEARER)).status, 200, 'Bearer para scripts')
  assert.equal((await j('GET', '/api/totems', null, { cookie: 'sa_op=1.forjado' })).status, 401)
})

// ── 3. Player routes stay public ─────────────────────────────────────────────
await scenario('rotas do jogador continuam públicas (join, status, sessão, QR)', async () => {
  const t = await j('POST', '/api/totems', { name: 'e2e-auth-pub', ip: '127.0.0.1', udpPort: 19998, maxPlayers: 1 }, { cookie })
  assert.equal(t.status, 201)
  created.push(t.body._id)
  const join = await j('POST', `/api/totems/${t.body._id}/queue/join`, { playerId: 'e2e_pub1' })
  assert.equal(join.status, 200)
  assert.equal((await j('GET', `/api/sessions/${join.body.sessionId}`)).status, 200)
  assert.equal((await j('GET', `/api/totems/${t.body._id}/qr`)).status, 200)
  const st = await j('GET', `/api/totems/${t.body._id}/queue/status?playerId=e2e_pub1`)
  assert.equal(st.body.status, 'play')
})

// ── 4. Totem key ─────────────────────────────────────────────────────────────
await scenario('totem novo tem chave: end-session e fila do jogo exigem X-Totem-Key', async () => {
  const t = await j('POST', '/api/totems', { name: 'e2e-auth-key', ip: '127.0.0.1', udpPort: 19997, maxPlayers: 2 }, { cookie })
  created.push(t.body._id)
  const key = t.body.gameKey
  assert.match(key ?? '', /^[\w-]{24}$/, 'chave criada no cadastro')
  await j('POST', `/api/totems/${t.body._id}/queue/join`, { playerId: 'e2e_key1' })

  assert.equal((await j('POST', `/api/totems/${t.body._id}/end-session`, { playerId: 'e2e_key1' })).status, 401)
  assert.equal((await j('POST', `/api/totems/${t.body._id}/end-session`, { playerId: 'e2e_key1' }, { 'X-Totem-Key': 'errada' })).status, 401)
  assert.equal((await j('GET', `/api/totems/${t.body._id}/queue`)).status, 401)
  assert.equal((await j('GET', `/api/totems/${t.body._id}/queue`, null, { 'X-Totem-Key': key })).status, 200)
  const died = await j('POST', `/api/totems/${t.body._id}/end-session`, { playerId: 'e2e_key1' }, { 'X-Totem-Key': key })
  assert.equal(died.status, 200, died.text)
  const reset = await j('POST', `/api/totems/${t.body._id}/end-session`, {}, { 'X-Totem-Key': key })
  assert.equal(reset.status, 200, 'reset com a chave')

  const rot = await j('POST', `/api/totems/${t.body._id}/game-key`, null, { cookie })
  assert.equal(rot.status, 200)
  assert.notEqual(rot.body.gameKey, key)
  assert.equal((await j('GET', `/api/totems/${t.body._id}/queue`, null, { 'X-Totem-Key': key })).status, 401, 'chave antiga morre')
  assert.equal((await j('GET', `/api/totems/${t.body._id}/queue`, null, { 'X-Totem-Key': rot.body.gameKey })).status, 200)
})

// ── 5. Legacy totem (no key) ─────────────────────────────────────────────────
await scenario('totem antigo sem chave: morte continua aberta, reset geral não', async () => {
  const t = await j('POST', '/api/totems', { name: 'e2e-auth-legacy', ip: '127.0.0.1', udpPort: 19996, maxPlayers: 1 }, { cookie })
  created.push(t.body._id)
  const mongo = new MongoClient(process.env.MONGO_URI)
  await mongo.connect()
  await mongo.db().collection('totems').updateOne({ _id: t.body._id }, { $unset: { gameKey: '' } })
  await mongo.close()

  await j('POST', `/api/totems/${t.body._id}/queue/join`, { playerId: 'e2e_leg1' })
  assert.equal((await j('POST', `/api/totems/${t.body._id}/end-session`, { playerId: 'e2e_leg1' })).status, 200)
  assert.equal((await j('POST', `/api/totems/${t.body._id}/end-session`, {})).status, 401, 'reset exige operador')
  assert.equal((await j('POST', `/api/totems/${t.body._id}/end-session`, {}, { cookie })).status, 200)
})

// ── 6. Public embed state has no personal data ───────────────────────────────
await scenario('queue-state público do iframe não expõe IP, navegador nem id completo', async () => {
  const t = await j('POST', '/api/totems', { name: 'e2e-auth-embed', game: 'snake', maxPlayers: 1 }, { cookie })
  created.push(t.body._id)
  const ctrl = new AbortController()
  fetch(`${BASE}/embed/${t.body._id}/authA/events`, { signal: ctrl.signal }).catch(() => {})
  await sleep(200)
  await j('POST', `/api/totems/${t.body._id}/queue/join?instance=authA`, { playerId: 'e2e_embed_longid', metadata: { lang: 'pt' } })
  const qs = await j('GET', `/embed/${t.body._id}/authA/queue-state`)
  ctrl.abort()
  assert.equal(qs.status, 200)
  assert.equal(qs.body.sessions.length, 1)
  assert.deepEqual(Object.keys(qs.body.sessions[0]).sort(), ['pid', 'status'])
  assert.equal(qs.body.sessions[0].pid, 'e2e_embe')
  assert.doesNotMatch(qs.text, /metadata|user-agent|"ip"/i)
})

// ── 7. History ───────────────────────────────────────────────────────────────
await scenario('histórico: só operador; conta partidas e motivos de fim', async () => {
  const tid = created[1] // totem do cenário 4: 1 morte + reset
  assert.equal((await j('GET', `/api/totems/${tid}/stats`)).status, 401)
  const s = await j('GET', `/api/totems/${tid}/stats?range=24h&tz=180`, null, { cookie })
  assert.equal(s.status, 200, s.text)
  assert.equal(s.body.buckets.length, 24)
  assert.ok(s.body.totals.sessions >= 1)
  assert.ok(s.body.endReasons.died >= 1, 'morte contada')
  assert.equal((await j('GET', `/api/totems/${tid}/stats?range=1y`, null, { cookie })).status, 400)
})

// ── 8. Logout ────────────────────────────────────────────────────────────────
await scenario('logout apaga o cookie', async () => {
  const out = await j('POST', '/api/auth/logout', null, { cookie })
  assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/)
})

// ── Cleanup ──────────────────────────────────────────────────────────────────
for (const id of created) await j('DELETE', `/api/totems/${id}`, null, BEARER)
server.kill()
console.log(failures === 0 ? '\nALL SCENARIOS PASSED' : `\n${failures} SCENARIO(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
