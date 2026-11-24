// tests/load/qa-extra.mjs
// Riscos de produção que o qa-queue (limites afrouxados) não cobre:
//  1. limite de join por IP com 30 pessoas na MESMA rede/NAT (limites padrão)
//  2. com TRUST_PROXY=false atrás de proxy, todos viram o mesmo IP
//  3. payloads grandes (playerId / metadata)
//  4. cue com autenticação ligada (chave do totem)
//  5. 30 assinantes do SSE da fila recebem o aviso quando a fila anda
// Run: node tests/load/qa-extra.mjs   (MongoDB + Redis)
import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const out = []
const log = (s) => { out.push(s); console.log(s) }

async function withServer(port, env, fn) {
  const server = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
  const errs = []
  server.stderr.on('data', d => errs.push(String(d)))
  const base = `http://localhost:${port}`
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) break } catch { /* boot */ } await sleep(250) }
  try { return await fn(base) } finally { server.kill() }
}
// O limitador é de janela fixa (10 s): começa cada rajada no início de uma janela.
const alignWindow = async () => { await sleep(10_000 - (Date.now() % 10_000) + 100) }
const post = (base, url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

// 1 + 2 + 3 ────────────────────────────────────────────────────────────────
await withServer(3211, { TRUST_PROXY: 'false', OPERATOR_PASSWORD: '', INSTANCE_GRACE_MS: '600000' }, async (base) => {
  const t = await (await post(base, '/api/totems', { name: 'qa-rate', game: 'nave', maxPlayers: 2 })).json()
  await alignWindow()
  const joins = await Promise.all(Array.from({ length: 30 }, (_, i) => post(base, `/api/totems/${t._id}/queue/join`, { playerId: `rate${i}` })))
  const codes = joins.map(r => r.status)
  const ok = codes.filter(c => c === 200).length
  const limited = codes.filter(c => c === 429).length
  log(`1. 30 pessoas, mesma rede, limite padrão (8/10 s): ${ok} entraram, ${limited} receberam 429`)

  // Mesmo teste com IPs diferentes (X-Forwarded-For só vale com TRUST_PROXY=true → aqui deve ser ignorado)
  await alignWindow()
  const spoof = await Promise.all(Array.from({ length: 30 }, (_, i) => post(base, `/api/totems/${t._id}/queue/join`, { playerId: `spoof${i}` }, { 'X-Forwarded-For': `203.0.113.${i + 1}` })))
  log(`2. mesmos 30 com X-Forwarded-For diferentes e TRUST_PROXY=false: ${spoof.filter(r => r.status === 200).length} entraram, ${spoof.filter(r => r.status === 429).length} 429 (o IP que conta é o do proxy)`)

  await alignWindow()
  const big = await post(base, `/api/totems/${t._id}/queue/join`, { playerId: 'x'.repeat(100_000) })
  log(`3a. playerId de 100 KB → ${big.status}`)
  await alignWindow()
  const meta = await post(base, `/api/totems/${t._id}/queue/join`, { playerId: 'metaP', metadata: { blob: 'y'.repeat(500_000) } })
  log(`3b. metadata de 500 KB → ${meta.status}`)
  await alignWindow()
  const huge = await post(base, `/api/totems/${t._id}/queue/join`, { playerId: 'bodyP', metadata: { blob: 'z'.repeat(2_000_000) } })
  log(`3c. corpo de 2 MB → ${huge.status}`)
})

// 4 ───────────────────────────────────────────────────────────────────────
await withServer(3212, { OPERATOR_PASSWORD: 'qa-secret-qa-secret', INSTANCE_GRACE_MS: '600000' }, async (base) => {
  const AUTH = { Authorization: 'Bearer qa-secret-qa-secret' }
  const t = await (await post(base, '/api/totems', { name: 'qa-auth', game: 'nave', maxPlayers: 2 }, AUTH)).json()
  const noKey = await post(base, `/api/totems/${t._id}/cue`, { cue: 'fire' })
  const withKey = await post(base, `/api/totems/${t._id}/cue`, { cue: 'fire' }, { 'X-Totem-Key': t.gameKey })
  const wrongKey = await post(base, `/api/totems/${t._id}/cue`, { cue: 'fire' }, { 'X-Totem-Key': 'errada' })
  log(`4. /api/totems/:id/cue com auth ligada: sem chave ${noKey.status}, chave certa ${withKey.status}, chave errada ${wrongKey.status}`)
})

// 5 ───────────────────────────────────────────────────────────────────────
await withServer(3213, { OPERATOR_PASSWORD: '', QUEUE_JOIN_RATE_MAX: '1000', INSTANCE_GRACE_MS: '600000' }, async (base) => {
  const t = await (await post(base, '/api/totems', { name: 'qa-sse', game: 'nave', maxPlayers: 1 })).json()
  const inst = 'sse1'
  const ctrl = new AbortController()
  fetch(`${base}/embed/${t._id}/${inst}/events`, { signal: ctrl.signal }).catch(() => {})
  await sleep(300)
  await post(base, `/api/totems/${t._id}/queue/join?instance=${inst}`, { playerId: 'sseP0' })
  const pings = new Array(30).fill(0)
  const ctrls = []
  for (let i = 0; i < 30; i++) {
    await post(base, `/api/totems/${t._id}/queue/join?instance=${inst}`, { playerId: `sseW${i}` })
    const c = new AbortController(); ctrls.push(c)
    fetch(`${base}/api/totems/${t._id}/queue/events?instance=${inst}`, { signal: c.signal }).then(async res => {
      const dec = new TextDecoder()
      for await (const chunk of res.body) if (/queue_changed|event: queue|data:/.test(dec.decode(chunk))) pings[i]++
    }).catch(() => {})
  }
  await sleep(500)
  const before = pings.slice()
  await post(base, `/embed/${t._id}/${inst}/end-session`, { pid: 'sseP0' }) // a fila anda
  await sleep(1500)
  const got = pings.filter((n, i) => n > before[i]).length
  log(`5. 30 celulares na fila com SSE aberto: ${got}/30 receberam o aviso quando a fila andou`)
  ctrls.forEach(c => c.abort()); ctrl.abort()
})
process.exit(0)
