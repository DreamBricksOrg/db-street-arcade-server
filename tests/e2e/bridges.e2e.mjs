// tests/e2e/bridges.e2e.mjs
// The games' local bridges (games/*/server.js) — what a physical cabinet's
// browser talks to. Each bridge runs against a FAKE backend that records the
// calls, so no MongoDB/Redis is needed. Run: npm run test:e2e
//
//   - serves the game, the brand font and marks; refuses paths outside public/
//   - UDP packet from the backend → SSE to the game page
//   - death (POST /end-session) and HUD (GET /queue-state) proxied WITH the
//     totem key (X-Totem-Key)

import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import dgram from 'node:dgram'
import assert from 'node:assert/strict'

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
const TOTEM_ID = '11111111-2222-3333-4444-555555555555'
const TOTEM_KEY = 'bridge-test-key'

/** Raw GET (no client-side path normalisation, so traversal is really sent). */
function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

// ── Fake backend ──────────────────────────────────────────────────────────────
const calls = []
const backend = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, key: req.headers['x-totem-key'], body })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url.endsWith('/queue')) res.end(JSON.stringify({ sessions: [], queue: [{ id: 'p1' }], maxPlayers: 4 }))
    else res.end(JSON.stringify({ ok: true }))
  })
})
await new Promise(r => backend.listen(0, '127.0.0.1', r))
const BACKEND_URL = `http://127.0.0.1:${backend.address().port}`

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

for (const game of ['snake', 'brick-rush']) {
  const httpPort = await freePort()
  const udpPort = await freePort()
  const bridge = spawn(process.execPath, [`games/${game}/server.js`], {
    env: { ...process.env, BRIDGE_HTTP_PORT: String(httpPort), BRIDGE_UDP_PORT: String(udpPort), BACKEND_URL, TOTEM_ID, TOTEM_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  bridge.stderr.on('data', d => process.stderr.write(`[${game}] ${d}`))
  for (let i = 0; i < 40; i++) {
    try { if ((await rawGet(httpPort, '/state')).status === 200) break } catch {}
    await sleep(150)
  }

  await scenario(`${game}: serve o jogo, a fonte Araboto e a marca`, async () => {
    const page = await rawGet(httpPort, '/')
    assert.equal(page.status, 200)
    assert.match(page.type, /text\/html/)
    const font = await rawGet(httpPort, '/assets/fonts/araboto/araboto-bold.woff2')
    assert.equal(font.status, 200)
    assert.equal(font.type, 'font/woff2')
    assert.equal(font.body.subarray(0, 4).toString(), 'wOF2', 'é um woff2 de verdade')
    const mark = await rawGet(httpPort, '/assets/brand/dreambricks-mark-blue.svg')
    assert.equal(mark.status, 200)
    assert.equal(mark.type, 'image/svg+xml')
  })

  await scenario(`${game}: não entrega nada fora de public/ (.env, server.js)`, async () => {
    for (const p of ['/../.env', '/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/assets/fonts/../../../../package.json', '/..\\server.js']) {
      const r = await rawGet(httpPort, p)
      assert.notEqual(r.status, 200, `${p} → ${r.status}`)
      assert.doesNotMatch(r.body.toString(), /TOTEM_KEY|createServer|"dependencies"/, p)
    }
  })

  await scenario(`${game}: pacote UDP do backend chega ao jogo pelo SSE`, async () => {
    const ctrl = new AbortController()
    const res = await fetch(`http://127.0.0.1:${httpPort}/events`, { signal: ctrl.signal })
    const seen = []
    ;(async () => {
      const dec = new TextDecoder()
      try { for await (const c of res.body) seen.push(dec.decode(c)) } catch {}
    })()
    await sleep(150)
    const sock = dgram.createSocket('udp4')
    const pkt = JSON.stringify({ sid: 'abcd1234', pid: 'qp_test1', a: 'btn_A', s: 1, ts: 1 })
    await new Promise(r => sock.send(pkt, udpPort, '127.0.0.1', r))
    sock.close()
    await sleep(300)
    ctrl.abort()
    const all = seen.join('')
    assert.match(all, /"type":"init"/)
    assert.ok(all.includes(pkt), 'input repassado como veio')
  })

  await scenario(`${game}: morte e HUD vão ao backend com a chave do totem`, async () => {
    calls.length = 0
    const died = await fetch(`http://127.0.0.1:${httpPort}/end-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: 'qp_test1' }),
    })
    assert.equal(died.status, 200)
    const hud = await (await fetch(`http://127.0.0.1:${httpPort}/queue-state`)).json()
    assert.equal(hud.queue.length, 1)

    const end = calls.find(c => c.url === `/api/totems/${TOTEM_ID}/end-session`)
    assert.ok(end, 'end-session repassado')
    assert.equal(end.method, 'POST')
    assert.equal(end.key, TOTEM_KEY)
    assert.deepEqual(JSON.parse(end.body), { playerId: 'qp_test1' })
    const q = calls.find(c => c.url === `/api/totems/${TOTEM_ID}/queue`)
    assert.equal(q?.key, TOTEM_KEY)
  })

  bridge.kill()
}

backend.close()
console.log(failures === 0 ? '\nALL SCENARIOS PASSED' : `\n${failures} SCENARIO(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
