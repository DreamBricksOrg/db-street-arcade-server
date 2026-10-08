// tests/e2e/auth.e2e.mjs
// Operator login + totem key, against the real server with OPERATOR_PASSWORD.
// Run: npm run test:e2e   (requires local MongoDB + Redis, same as dev)

import { spawn, execFileSync } from 'node:child_process'
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
  assert.deepEqual((await j('GET', '/api/auth/me')).body, { operator: false, authEnabled: true, user: null })
})

// ── 2. Login ─────────────────────────────────────────────────────────────────
await scenario('login: senha errada 401; certa grava cookie HttpOnly que libera a API', async () => {
  assert.equal((await j('POST', '/api/auth/login', { password: 'errada' })).status, 401)
  const ok = await j('POST', '/api/auth/login', { password: PASSWORD })
  assert.equal(ok.status, 200)
  const setCookie = ok.headers.get('set-cookie') ?? ''
  assert.match(setCookie, /^sa_op=\d+\.[\w-]+\.[\w-]+;/)
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

  // npm run ops:totem-keys: lists it without changing anything; --apply fixes it
  const dry = execFileSync(process.execPath, ['scripts/totem-keys.mjs'], { env: process.env }).toString()
  assert.ok(dry.includes(t.body._id), 'listado como sem chave')
  assert.match(dry, /Nada foi alterado/)
  assert.equal((await j('GET', `/api/totems/${t.body._id}`, null, { cookie })).body.gameKey ?? null, null)
  const applied = execFileSync(process.execPath, ['scripts/totem-keys.mjs', '--apply'], { env: process.env }).toString()
  const key = applied.match(new RegExp(`TOTEM_ID=${t.body._id}\\s+TOTEM_KEY=([\\w-]+)`))?.[1]
  assert.ok(key, 'imprime TOTEM_ID/TOTEM_KEY para o .env da máquina')
  assert.equal((await j('GET', `/api/totems/${t.body._id}`, null, { cookie })).body.gameKey, key)
  assert.equal((await j('POST', `/api/totems/${t.body._id}/end-session`, { playerId: 'x' })).status, 401, 'agora exige a chave')
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
  assert.deepEqual(Object.keys(qs.body.sessions[0]).sort(), ['name', 'pid', 'status'])
  assert.match(qs.body.sessions[0].name, /^\S+ \S+/, 'apelido de animal')
  assert.ok(!qs.body.sessions[0].name.includes('e2e_'), 'apelido não revela o id')
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

// ── 9. Operator accounts + activity log ─────────────────────────────────────
const createdUsers = []
await scenario('usuários: operador entra com a própria senha, não administra, e o que faz vai para a atividade', async () => {
  const username = `e2e.op${Math.random().toString(36).slice(2, 6)}`
  const mk = await j('POST', '/api/users', { username, name: 'Operadora Teste', password: 'senha-do-op-1', role: 'operator' }, BEARER)
  assert.equal(mk.status, 201, mk.text)
  createdUsers.push(mk.body.id)
  assert.equal(mk.body.passwordHash, undefined, 'hash nunca sai na API')
  assert.equal((await j('POST', '/api/users', { username, name: 'x', password: 'senha-do-op-1', role: 'operator' }, BEARER)).status, 409)
  assert.equal((await j('POST', '/api/users', { username: 'curta', name: 'x', password: '123', role: 'operator' }, BEARER)).status, 400)

  assert.equal((await j('POST', '/api/auth/login', { username, password: 'errada-123' })).status, 401)
  const login = await j('POST', '/api/auth/login', { username: username.toUpperCase(), password: 'senha-do-op-1' })
  assert.equal(login.status, 200, login.text)
  const opCookie = login.headers.get('set-cookie').split(';')[0]
  const me = await j('GET', '/api/auth/me', null, { cookie: opCookie })
  assert.deepEqual([me.body.user.username, me.body.user.role], [username, 'operator'])

  assert.equal((await j('GET', '/api/totems', null, { cookie: opCookie })).status, 200, 'opera totens')
  assert.equal((await j('GET', '/api/users', null, { cookie: opCookie })).status, 403, 'não administra usuários')
  assert.equal((await j('GET', '/api/audit', null, { cookie: opCookie })).status, 403)
  assert.equal((await j('PUT', '/api/settings/nicknames', { animals: ['A'], adjectives: ['B'] }, { cookie: opCookie })).status, 403)

  const t = await j('POST', '/api/totems', { name: 'e2e-audit', game: 'snake' }, { cookie: opCookie })
  created.push(t.body._id)
  await j('POST', `/api/totems/${t.body._id}/pause`, { paused: true }, { cookie: opCookie })
  await sleep(200)
  const log = await j('GET', `/api/audit?username=${username}`, null, BEARER)
  const actions = log.body.map(e => e.action)
  assert.ok(actions.includes('auth.login'), actions.join(','))
  assert.ok(actions.includes('POST /api/totems'), 'criação de totem registrada')
  assert.ok(actions.includes('totem.pause'), 'pausa registrada')
  assert.ok(log.body.every(e => e.username === username && e.name === 'Operadora Teste'))
  const failed = await j('GET', '/api/audit?action=auth.login_failed', null, BEARER)
  assert.ok(failed.body.some(e => e.details?.username === username), 'tentativa errada registrada')

  // New password → old cookie stops working; disabled account can't log in
  await j('PUT', `/api/users/${mk.body.id}`, { password: 'senha-nova-456' }, BEARER)
  assert.equal((await j('GET', '/api/totems', null, { cookie: opCookie })).status, 401, 'troca de senha derruba o login antigo')
  await j('PUT', `/api/users/${mk.body.id}`, { disabled: true }, BEARER)
  assert.equal((await j('POST', '/api/auth/login', { username, password: 'senha-nova-456' })).status, 401, 'desativado não entra')
})

// ── Cleanup ──────────────────────────────────────────────────────────────────
for (const id of created) await j('DELETE', `/api/totems/${id}`, null, BEARER)
for (const id of createdUsers) await j('DELETE', `/api/users/${id}`, null, BEARER)
server.kill()
console.log(failures === 0 ? '\nALL SCENARIOS PASSED' : `\n${failures} SCENARIO(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
