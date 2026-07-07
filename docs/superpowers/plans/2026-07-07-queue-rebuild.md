# Queue Rebuild (1 Sessão por Jogador) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o modelo "sessão compartilhada por totem" por "1 sessão por jogador", com fila FIFO que avança automaticamente quando qualquer sessão termina.

**Architecture:** Um novo `TotemQueueService` é o único dono do ciclo fila→sessão→vaga, serializado por mutex por-totem. Sessão tem dono único (`playerId`) e máquina de estados `reserved → active → finished`. `SessionService` é deletado; `TotemService` vira CRUD puro; a dependência circular morre. O jogo (demo-snake) recebe `player_join`/`player_leave` via UDP em vez de "reset de board".

**Tech Stack:** Node ≥20 ESM, Fastify 5, MongoDB, Redis (ioredis), UDP dgram. Teste: script e2e (`node`, WebSocket nativo do Node 22) contra servidor real em porta isolada.

**Spec:** `docs/superpowers/specs/2026-07-07-queue-rebuild-design.md`

---

## File Map

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `src/config/env.js` | Modify | + `queueReserveMs` (30s), `queueSweepMs` (10s) — overridable p/ teste |
| `src/plugins/mongodb.js` | Modify | + índice `{ totemId: 1, status: 1 }` em sessions |
| `src/modules/session/session.repository.js` | Rewrite | CRUD do novo schema de sessão por-jogador |
| `src/modules/session/session.cache.js` | Rewrite | Cache Redis do novo shape (dispatcher lê `totems`) |
| `src/modules/session/session.service.js` | **Delete** | Lógica migra para TotemQueueService |
| `src/modules/totem/totemQueue.service.js` | **Create** | join/status/claim/advance/endSession/sweep/operatorView |
| `src/modules/totem/totem.service.js` | Rewrite | CRUD de totem apenas |
| `src/modules/game/game.handler.js` | Rewrite | WS claim (reserved→active), player_join UDP |
| `src/modules/totem/totem.routes.js` | Rewrite | Rotas de fila usam totemQueue; remove `/session` legado |
| `src/modules/session/session.routes.js` | Rewrite | list/get/end/kick/delete/qr; sem create/join/player-died/watcher |
| `tests/e2e/queue.e2e.mjs` | **Create** | Verificação e2e completa (8 cenários) |
| `demo-snake/public/game.js` | Modify | player_leave remove cobra; sem reset de board; sem respawn |
| `public/session.js` | Modify | Tela "fim de jogo" + botão voltar pra fila |
| `public/dashboard.js` | Modify | Card = ocupação X/N + Encerrar Todas; modal usa `sessions` |
| `CLAUDE.md`, `prd.md` | Modify | Documentar novo modelo |

Mantidos sem mudança: `src/lib/mutex.js`, `src/lib/rateLimit.js`, `src/modules/udp/udp.dispatcher.js` (o campo `totems` continua no doc/cache), `public/totem-entry.*`, `demo-snake/server.js` (proxy já manda `{playerId}`).

**Convenção crítica — pid truncado:** o dispatcher UDP corta `pid`/`sid` para 8 chars. O jogo só conhece o pid truncado. Toda busca "sessão do jogador X vinda do jogo" compara por `playerId.slice(0, 8)`.

---

### Task 1: Env vars de timing + índice Mongo + e2e RED

**Files:**
- Modify: `src/config/env.js`
- Modify: `src/plugins/mongodb.js`
- Create: `tests/e2e/queue.e2e.mjs`
- Modify: `package.json` (script `test:e2e`)

- [ ] **Step 1.1: Adicionar env vars de timing** em `src/config/env.js`, dentro do objeto `env` após `sessionMaxPlayers`:

```js
  // Queue rebuild — claim window and sweeper cadence (short values in tests)
  queueReserveMs: parseInt(process.env.QUEUE_RESERVE_MS ?? '30000', 10),
  queueSweepMs:   parseInt(process.env.QUEUE_SWEEP_MS   ?? '10000', 10),
```

- [ ] **Step 1.2: Índice composto** em `src/plugins/mongodb.js` — localizar onde os índices de `sessions` são criados (grep `createIndex`) e adicionar na sequência:

```js
await db.collection('sessions').createIndex({ totemId: 1, status: 1 })
```

- [ ] **Step 1.3: Escrever o teste e2e** `tests/e2e/queue.e2e.mjs` (código completo abaixo). Ele sobe o servidor como child process na porta 3100 com `QUEUE_RESERVE_MS=2000` e `QUEUE_SWEEP_MS=500`, roda os cenários e imprime PASS/FAIL por cenário, saindo com exit code ≠ 0 em falha.

```js
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
  env: { ...process.env, PORT: String(PORT), QUEUE_RESERVE_MS: '2000', QUEUE_SWEEP_MS: '500' },
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
```

- [ ] **Step 1.4: npm script** em `package.json` scripts:

```json
"test:e2e": "node tests/e2e/queue.e2e.mjs"
```

- [ ] **Step 1.5: Rodar e confirmar RED**

Run: `npm run test:e2e`
Expected: múltiplos FAIL (comportamento antigo: sessionIds iguais no cenário 1, sem endReason no_show, etc.). O servidor deve ao menos subir.

- [ ] **Step 1.6: Commit**

```bash
git add src/config/env.js src/plugins/mongodb.js tests/e2e/queue.e2e.mjs package.json
git commit -m "test(queue): add e2e harness for per-player-session model (red)"
```

---

### Task 2: SessionRepository — novo schema

**Files:**
- Rewrite: `src/modules/session/session.repository.js`

- [ ] **Step 2.1: Substituir o arquivo inteiro** por:

```js
// src/modules/session/session.repository.js
// Raw database operations for the sessions collection.
// A session is ONE player's connection to ONE totem:
//   reserved → active → finished        (normal flow)
//   reserved → finished (no_show/kick)  (never claimed)
// Finished sessions persist forever for historical records.

import { v4 as uuidv4 } from 'uuid'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('session.repository')

const CURRENT = ['reserved', 'active']

export class SessionRepository {
  /** @param {import('@fastify/mongodb').FastifyMongoObject} mongo */
  constructor(mongo) {
    this.col = mongo.client.db().collection('sessions')
  }

  /**
   * Creates a session in 'reserved' state for a single player.
   * @param {{ totemId: string, playerId: string, totems: Array<{id, ip, udpPort}>,
   *           metadata?: object|null, reserveMs: number, playMs: number }} data
   */
  async create({ totemId, playerId, totems, metadata = null, reserveMs, playMs }) {
    const now = new Date()
    const session = {
      _id:            uuidv4(),
      totemId,
      playerId,
      status:         'reserved',
      totems,
      metadata,
      gameDurationMs: playMs,
      createdAt:      now,
      reservedUntil:  new Date(now.getTime() + reserveMs),
      expiresAt:      new Date(now.getTime() + reserveMs + playMs),
      endedAt:        null,
      endReason:      null,
    }
    await this.col.insertOne(session)
    log.debug({ sessionId: session._id, totemId, playerId }, 'Session created (reserved)')
    return session
  }

  async findById(id) {
    return this.col.findOne({ _id: id })
  }

  /** The player's live (reserved or active) session on this totem, if any. */
  async findCurrentByPlayer(totemId, playerId) {
    return this.col.findOne({ totemId, playerId, status: { $in: CURRENT } })
  }

  /** All live sessions of a totem, oldest first. */
  async listCurrentByTotem(totemId) {
    return this.col.find({ totemId, status: { $in: CURRENT } }, { sort: { createdAt: 1 } }).toArray()
  }

  async countCurrent(totemId) {
    return this.col.countDocuments({ totemId, status: { $in: CURRENT } })
  }

  /** All live sessions across every totem (operator listing). */
  async listCurrentAll(limit = 100) {
    return this.col.find({ status: { $in: CURRENT } }, { sort: { createdAt: -1 }, limit }).toArray()
  }

  /**
   * reserved → active. The play clock starts NOW (expiresAt is reset from
   * claim time, not creation time). Returns the updated doc or null if the
   * session wasn't in 'reserved' (already active, finished, or missing).
   */
  async activate(id) {
    const doc = await this.col.findOne({ _id: id })
    if (!doc || doc.status !== 'reserved') return null
    return this.col.findOneAndUpdate(
      { _id: id, status: 'reserved' },
      { $set: { status: 'active', expiresAt: new Date(Date.now() + doc.gameDurationMs) } },
      { returnDocument: 'after' },
    )
  }

  /** → finished. Returns updated doc, or null if it was already finished. */
  async markEnded(id, reason) {
    return this.col.findOneAndUpdate(
      { _id: id, status: { $in: CURRENT } },
      { $set: { status: 'finished', endedAt: new Date(), endReason: reason } },
      { returnDocument: 'after' },
    )
  }

  /** Sessions past their deadline: unclaimed reservations and out-of-time actives. */
  async findExpired(now = new Date()) {
    return this.col.find({
      $or: [
        { status: 'reserved', reservedUntil: { $lte: now } },
        { status: 'active',   expiresAt:     { $lte: now } },
      ],
    }).toArray()
  }

  /** Recent finished rounds of a totem — used for queue wait estimates. */
  async findRecentFinished(totemId, limit = 5) {
    return this.col.find(
      { totemId, status: 'finished', endedAt: { $ne: null } },
      { sort: { endedAt: -1 }, limit },
    ).toArray()
  }

  /** Hard delete (admin cleanup only). */
  async delete(id) {
    const result = await this.col.deleteOne({ _id: id })
    return result.deletedCount > 0
  }
}
```

- [ ] **Step 2.2: Verificar sintaxe**

Run: `node --check src/modules/session/session.repository.js`
Expected: sem saída (OK)

- [ ] **Step 2.3: Commit**

```bash
git add src/modules/session/session.repository.js
git commit -m "feat(queue): rewrite session repository for per-player sessions"
```

---

### Task 3: SessionCache — novo shape

**Files:**
- Rewrite: `src/modules/session/session.cache.js`

- [ ] **Step 3.1: Substituir o arquivo inteiro** por (o campo `totems` JSON é lido pelo `udp.dispatcher._resolveTotems` — manter o nome):

```js
// src/modules/session/session.cache.js
// Redis cache of the per-player session. The UDP dispatcher reads the
// 'totems' field of this HASH as its 2nd resolution layer — keep that name.

import { SessionKey } from '../../lib/channels.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('session.cache')

export class SessionCache {
  /** @param {import('ioredis').Redis} [redis] */
  constructor(redis) {
    this.redis = redis ?? null
  }

  async set(session) {
    if (!this.redis) return
    const key = SessionKey(session._id)
    const ttlSecs = Math.max(60, Math.floor((new Date(session.expiresAt) - Date.now()) / 1000))
    await this.redis.hset(key, {
      id:        session._id,
      totemId:   session.totemId ?? '',
      playerId:  session.playerId ?? '',
      status:    session.status,
      totems:    JSON.stringify(session.totems ?? []),
      expiresAt: String(new Date(session.expiresAt).getTime()),
    })
    await this.redis.expire(key, ttlSecs)
    log.debug({ sessionId: session._id, ttlSecs }, 'Session cached')
  }

  async get(sessionId) {
    if (!this.redis) return null
    const raw = await this.redis.hgetall(SessionKey(sessionId))
    if (!raw || !raw.id) return null
    return {
      _id:       raw.id,
      totemId:   raw.totemId || null,
      playerId:  raw.playerId || null,
      status:    raw.status,
      totems:    JSON.parse(raw.totems || '[]'),
      expiresAt: new Date(parseInt(raw.expiresAt, 10)),
    }
  }

  async del(sessionId) {
    if (!this.redis) return
    await this.redis.del(SessionKey(sessionId))
  }
}
```

- [ ] **Step 3.2: Verificar sintaxe e commitar**

```bash
node --check src/modules/session/session.cache.js
git add src/modules/session/session.cache.js
git commit -m "feat(queue): rewrite session cache for per-player shape"
```

---

### Task 4: TotemQueueService — o coração

**Files:**
- Create: `src/modules/totem/totemQueue.service.js`

- [ ] **Step 4.1: Criar o arquivo** com o código completo:

```js
// src/modules/totem/totemQueue.service.js
// Single owner of the queue→session→slot lifecycle.
//
// Model: one session per player. A totem with maxPlayers=N holds up to N
// live sessions (reserved|active). When any session ends, advance() pops the
// next living player from the Redis queue and reserves a fresh session for
// them (they have env.queueReserveMs to claim it via WebSocket connect).
//
// Every mutating public method serializes on a per-totem mutex so concurrent
// requests can never double-book a slot or duplicate sessions.

import { SessionRepository } from '../session/session.repository.js'
import { SessionCache }      from '../session/session.cache.js'
import { Channels, buildMessage } from '../../lib/channels.js'
import { createKeyedMutex }  from '../../lib/mutex.js'
import { env }               from '../../config/env.js'
import { createLogger }      from '../../lib/logger.js'

const log = createLogger('totem.queue')

const HEARTBEAT_SECS = 120

export class TotemQueueService {
  /**
   * @param {import('fastify').FastifyInstance} fastify  (mongo, redisPublisher; gameHandler/udpSend/udpDispatcher lazily at call time)
   * @param {import('./totem.service.js').TotemService} totemService
   */
  constructor(fastify, totemService) {
    this._fastify = fastify
    this._totems  = totemService
    this.repo     = new SessionRepository(fastify.mongo)
    this.cache    = new SessionCache(fastify.redisPublisher)
    this._redis   = fastify.redisPublisher ?? null
    this._lock    = createKeyedMutex()
  }

  // ── Player-facing ────────────────────────────────────────────────────────

  /**
   * Player scans the QR / retries. Idempotent: an existing live session for
   * this player is returned as-is.
   * @returns {{ok:true,status:'play',sessionId}|{ok:true,status:'queue',position,estimatedWaitMs}|{ok:false,code,error}}
   */
  async join(totemId, playerId, metadata = null) {
    return this._lock(totemId, () => this._joinLocked(totemId, playerId, metadata))
  }

  async _joinLocked(totemId, playerId, metadata) {
    const totem = await this._totems.findTotem(totemId)
    if (!totem) return { ok: false, code: 404, error: 'Totem not found' }

    const existing = await this.repo.findCurrentByPlayer(totemId, playerId)
    if (existing) return { ok: true, status: 'play', sessionId: existing._id }

    const maxPlayers = totem.maxPlayers ?? env.sessionMaxPlayers
    const occupied   = await this.repo.countCurrent(totemId)
    const queueSize  = await this._queueLen(totemId)

    if (occupied < maxPlayers && queueSize === 0) {
      const session = await this._createReserved(totem, playerId, metadata)
      return { ok: true, status: 'play', sessionId: session._id }
    }

    if (!this._redis) return { ok: false, code: 503, error: 'Queue unavailable (Redis offline)' }
    if (totem.maxQueueSize && queueSize >= totem.maxQueueSize) {
      return { ok: false, code: 409, error: 'Queue is full' }
    }

    const position = await this._enqueue(totemId, playerId, metadata)
    const estimatedWaitMs = await this.estimateWait(totem, position)
    return { ok: true, status: 'queue', position, estimatedWaitMs }
  }

  /**
   * Poll from the waiting screen. Refreshes the heartbeat, self-heals by
   * advancing if slots are free, and reports 'play' once a session exists.
   */
  async status(totemId, playerId) {
    return this._lock(totemId, async () => {
      const totem = await this._totems.findTotem(totemId)
      if (!totem) return { ok: false, code: 404, error: 'Totem not found' }

      let session = await this.repo.findCurrentByPlayer(totemId, playerId)
      if (!session) {
        if (this._redis) await this._redis.setex(this._hbKey(playerId), HEARTBEAT_SECS, '1')
        await this._advanceLocked(totem)
        session = await this.repo.findCurrentByPlayer(totemId, playerId)
      }
      if (session) return { ok: true, status: 'play', sessionId: session._id }

      if (!this._redis) return { ok: false, code: 404, error: 'Not in queue' }
      const pos = await this._redis.lpos(this._qKey(totemId), playerId)
      if (pos === null) return { ok: false, code: 404, error: 'Not in queue' }

      const size = await this._queueLen(totemId)
      const estimatedWaitMs = await this.estimateWait(totem, pos + 1)
      return { ok: true, status: 'queue', position: pos + 1, size, estimatedWaitMs }
    })
  }

  /**
   * WebSocket connect claims the session: reserved → active (play clock
   * starts). Rejects wrong player / finished / unknown sessions.
   * @returns {{ok:true, session}|{ok:false, error}}
   */
  async claim(sessionId, playerId) {
    const session = await this.repo.findById(sessionId)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.playerId !== playerId) return { ok: false, error: 'You are not allowed in this session' }
    if (session.status === 'finished') return { ok: false, error: 'Session already finished' }
    if (session.status === 'active') return { ok: true, session }

    return this._lock(session.totemId, async () => {
      const activated = await this.repo.activate(sessionId)
      if (activated) {
        await this.cache.set(activated)
        log.info({ sessionId, playerId }, 'Session claimed (reserved → active)')
        return { ok: true, session: activated }
      }
      const fresh = await this.repo.findById(sessionId)
      if (fresh?.status === 'active') return { ok: true, session: fresh }
      return { ok: false, error: 'Session already finished' }
    })
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Ends ONE player's session (death, kick, timeout, no_show, manual) and
   * advances the queue into the freed slot.
   */
  async endSession(sessionId, reason = 'manual') {
    const session = await this.repo.findById(sessionId)
    if (!session) return { ok: false, code: 404, error: 'Session not found' }
    if (session.status === 'finished') return { ok: true, alreadyEnded: true }

    return this._lock(session.totemId, async () => {
      const ended = await this.repo.markEnded(sessionId, reason)
      if (!ended) return { ok: true, alreadyEnded: true }

      await this.cache.del(sessionId)
      this._fastify.gameHandler?.disconnectPlayer(sessionId, ended.playerId, 1008, 'Session ended')
      this._fastify.udpDispatcher?.unregisterSession(sessionId)
      this._sendPlayerLeave(ended)
      await this._publish(Channels.gameEvent(sessionId), 'event', sessionId, null, {
        event: 'session_ended', reason,
      })

      log.info({ sessionId, playerId: ended.playerId, reason }, 'Session ended')

      const totem = await this._totems.findTotem(session.totemId)
      if (totem) await this._advanceLocked(totem)
      return { ok: true }
    })
  }

  /** Operator reset: ends every live session of the totem, then advances. */
  async endAllForTotem(totemId, reason = 'manual') {
    const sessions = await this.repo.listCurrentByTotem(totemId)
    for (const s of sessions) await this.endSession(s._id, reason)
    return { ok: true, endedCount: sessions.length }
  }

  /**
   * Fills free slots from the queue. Called on session end, on status polls,
   * and by the sweeper. MUST be called with the totem's lock already held.
   */
  async _advanceLocked(totem) {
    if (!this._redis) return
    const totemId    = totem._id.toString()
    const maxPlayers = totem.maxPlayers ?? env.sessionMaxPlayers
    let advanced = 0

    while ((await this.repo.countCurrent(totemId)) < maxPlayers) {
      const playerId = await this._redis.lpop(this._qKey(totemId))
      if (!playerId) break

      const alive = await this._redis.get(this._hbKey(playerId))
      if (!alive) {
        log.info({ totemId, playerId }, 'Skipping ghost (heartbeat expired)')
        continue
      }

      let metadata = null
      try {
        const raw = await this._redis.get(this._mKey(playerId))
        metadata = raw ? JSON.parse(raw) : null
      } catch { /* metadata is best-effort */ }

      await this._redis.del(this._hbKey(playerId))
      const session = await this._createReserved(totem, playerId, metadata)
      advanced++
      log.info({ totemId, playerId, sessionId: session._id }, 'Queue advanced — slot reserved')
    }

    if (advanced > 0) await this._publishQueueEvent(totemId)
  }

  /**
   * Expires unclaimed reservations (no_show) and out-of-time actives
   * (timeout). Runs every env.queueSweepMs — replaces the old watcher.
   */
  async sweep() {
    const expired = await this.repo.findExpired()
    for (const s of expired) {
      const reason = s.status === 'reserved' ? 'no_show' : 'timeout'
      await this.endSession(s._id, reason).catch(err =>
        log.error({ err: err.message, sessionId: s._id }, 'Sweep endSession failed'))
    }
  }

  // ── Queue management (operator) ──────────────────────────────────────────

  async kickFromQueue(totemId, playerId) {
    return this._lock(totemId, async () => {
      if (!this._redis) return { ok: true }
      const removed = await this._redis.lrem(this._qKey(totemId), 0, playerId)
      await this._redis.del(this._hbKey(playerId))
      if (removed > 0) await this._publishQueueEvent(totemId)
      return { ok: true, removed: removed > 0 }
    })
  }

  /** Clears the waiting list ONLY — live sessions are independent now. */
  async clearQueue(totemId) {
    return this._lock(totemId, async () => {
      if (this._redis) {
        await this._redis.del(this._qKey(totemId))
        await this._publishQueueEvent(totemId)
      }
      log.info({ totemId }, 'Queue cleared')
      return { ok: true }
    })
  }

  /** Dashboard view: live sessions + waiting list with metadata/TTL/ETA. */
  async operatorView(totemId) {
    const totem = await this._totems.findTotem(totemId)
    if (!totem) return { ok: false, code: 404, error: 'Totem not found' }

    const sessions = await this.repo.listCurrentByTotem(totemId)
    const ids = this._redis ? await this._redis.lrange(this._qKey(totemId), 0, -1) : []
    const queue = await Promise.all(ids.map(async (pid, i) => {
      let metadata = null
      try {
        const raw = this._redis ? await this._redis.get(this._mKey(pid)) : null
        metadata = raw ? JSON.parse(raw) : null
      } catch { /* best-effort */ }
      return {
        id: pid,
        metadata,
        heartbeatTtl:    this._redis ? await this._redis.ttl(this._hbKey(pid)) : null,
        estimatedWaitMs: await this.estimateWait(totem, i + 1),
      }
    }))

    return {
      ok: true,
      sessions: sessions.map(s => ({
        sessionId: s._id,
        playerId:  s.playerId,
        status:    s.status,
        metadata:  s.metadata,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
      })),
      queue,
      maxPlayers:   totem.maxPlayers ?? env.sessionMaxPlayers,
      maxQueueSize: totem.maxQueueSize ?? null,
    }
  }

  /** Finds a live session by the (possibly 8-char-truncated) pid the game knows. */
  async findCurrentByPidPrefix(totemId, pid) {
    const sessions = await this.repo.listCurrentByTotem(totemId)
    return sessions.find(s => s.playerId === pid || s.playerId.slice(0, 8) === pid.slice(0, 8)) ?? null
  }

  /** Rough ETA: rounds to wait × average real duration of recent rounds. */
  async estimateWait(totem, position) {
    const fallback = totem.sessionDurationMs ?? env.sessionTimeoutMs
    const recent = await this.repo.findRecentFinished(totem._id.toString(), 5)
    const durations = recent
      .filter(s => s.createdAt && s.endedAt)
      .map(s => new Date(s.endedAt).getTime() - new Date(s.createdAt).getTime())
      .filter(ms => ms > 0)
    const avg = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : fallback
    const mp = totem.maxPlayers || 1
    return Math.ceil(position / mp) * avg
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _qKey(totemId)   { return `queue:totem:${totemId}` }
  _hbKey(playerId) { return `queue:heartbeat:${playerId}` }
  _mKey(playerId)  { return `player:metadata:${playerId}` }

  async _queueLen(totemId) {
    if (!this._redis) return 0
    return this._redis.llen(this._qKey(totemId))
  }

  async _enqueue(totemId, playerId, metadata) {
    await this._redis.setex(this._hbKey(playerId), HEARTBEAT_SECS, '1')
    if (metadata) await this._redis.setex(this._mKey(playerId), HEARTBEAT_SECS, JSON.stringify(metadata))

    const pos = await this._redis.lpos(this._qKey(totemId), playerId)
    if (pos !== null) return pos + 1

    await this._redis.rpush(this._qKey(totemId), playerId)
    await this._publishQueueEvent(totemId)
    return this._redis.llen(this._qKey(totemId))
  }

  async _createReserved(totem, playerId, metadata) {
    const session = await this.repo.create({
      totemId:  totem._id.toString(),
      playerId,
      totems:   [{ id: totem._id, ip: totem.ip, udpPort: totem.udpPort }],
      metadata,
      reserveMs: env.queueReserveMs,
      playMs:    totem.sessionDurationMs ?? env.sessionTimeoutMs,
    })
    await this.cache.set(session)
    await this._publishQueueEvent(totem._id.toString())
    return session
  }

  /** Tells the game (via UDP) to remove this player's avatar immediately. */
  _sendPlayerLeave(session) {
    const packet = JSON.stringify({
      type: 'player_leave',
      sid:  session._id.slice(0, 8),
      pid:  (session.playerId ?? '').slice(0, 8),
      tid:  session.totemId ?? null,
    })
    for (const t of session.totems ?? []) {
      this._fastify.udpSend?.(t.ip, t.udpPort, packet).catch(err =>
        log.warn({ err: err.message, ip: t.ip }, 'UDP player_leave failed'))
    }
  }

  async _publishQueueEvent(totemId) {
    if (!this._redis) return
    try {
      await this._redis.publish(`queue:event:${totemId}`, JSON.stringify({ type: 'queue_changed', totemId, ts: Date.now() }))
    } catch (err) {
      log.warn({ err: err.message, totemId }, 'Queue event publish failed')
    }
  }

  async _publish(channel, type, sessionId, playerId, data) {
    if (!this._redis) return
    try {
      await this._redis.publish(channel, buildMessage(type, sessionId, playerId, data))
    } catch (err) {
      log.error({ err: err.message, channel }, 'Redis publish failed')
    }
  }
}
```

**Nota de deadlock:** o mutex é uma cadeia de promises — re-entrar no mesmo `totemId` trava. Por isso `_advanceLocked`/`_joinLocked` NUNCA chamam `this._lock`; só os métodos públicos fazem lock. `endSession` dentro de `endAllForTotem`/`sweep` é chamado FORA de lock (cada `endSession` pega o seu).

- [ ] **Step 4.2: Verificar sintaxe e commitar**

```bash
node --check src/modules/totem/totemQueue.service.js
git add src/modules/totem/totemQueue.service.js
git commit -m "feat(queue): add TotemQueueService — single owner of queue lifecycle"
```

---

### Task 5: TotemService → CRUD puro

**Files:**
- Rewrite: `src/modules/totem/totem.service.js`

- [ ] **Step 5.1: Substituir o arquivo inteiro** por (mantém create/list/find/update/delete e queueSize na listagem; TODO o resto sai):

```js
// src/modules/totem/totem.service.js
// CRUD-only business logic for totems. The queue/session lifecycle lives in
// totemQueue.service.js — this file no longer touches sessions at all.

import { TotemRepository } from './totem.repository.js'
import { createLogger }    from '../../lib/logger.js'

const log = createLogger('totem.service')

export class TotemService {
  /**
   * @param {import('@fastify/mongodb').FastifyMongoObject} mongo
   * @param {import('ioredis').Redis} [redisPublisher]  Only for queueSize in listTotems
   */
  constructor(mongo, redisPublisher) {
    this.repo      = new TotemRepository(mongo)
    this._redisPub = redisPublisher ?? null
  }

  async createTotem({ name, ip, udpPort, maxPlayers, sessionDurationMs, maxQueueSize }) {
    if (!name?.trim()) return { ok: false, error: 'name is required' }
    if (!ip?.trim())   return { ok: false, error: 'ip is required' }
    if (!udpPort || udpPort < 1 || udpPort > 65535)
      return { ok: false, error: 'udpPort must be between 1 and 65535' }

    const mp  = maxPlayers        ? Number(maxPlayers)        : undefined
    const dur = sessionDurationMs ? Number(sessionDurationMs) : undefined
    const mqs = maxQueueSize      ? Number(maxQueueSize)      : undefined

    if (mp  !== undefined && (mp < 1 || mp > 8))     return { ok: false, error: 'maxPlayers must be 1–8' }
    if (dur !== undefined && dur < 60_000)           return { ok: false, error: 'sessionDurationMs must be >= 60000 (1 min)' }
    if (mqs !== undefined && (mqs < 1 || mqs > 200)) return { ok: false, error: 'maxQueueSize must be 1–200' }

    const totem = await this.repo.create({
      name: name.trim(), ip: ip.trim(), udpPort,
      maxPlayers: mp, sessionDurationMs: dur, maxQueueSize: mqs,
    })
    log.info({ totemId: totem._id, name: totem.name }, 'Totem created')
    return { ok: true, totem }
  }

  async listTotems() {
    const totems = await this.repo.list()
    if (this._redisPub) {
      await Promise.all(totems.map(async (t) => {
        t.queueSize = await this._redisPub.llen(`queue:totem:${t._id}`)
      }))
    }
    return totems
  }

  async findTotem(id) {
    return this.repo.findById(id)
  }

  async updateTotem(id, fields) {
    const exists = await this.repo.findById(id)
    if (!exists) return { ok: false, error: 'Totem not found' }

    const patch = {}
    if (fields.name    !== undefined) patch.name = fields.name.trim()
    if (fields.ip      !== undefined) patch.ip   = fields.ip.trim()
    if (fields.udpPort !== undefined) {
      const port = Number(fields.udpPort)
      if (port < 1 || port > 65535) return { ok: false, error: 'udpPort must be between 1 and 65535' }
      patch.udpPort = port
    }
    if (fields.maxPlayers !== undefined) {
      const mp = Number(fields.maxPlayers)
      if (mp < 1 || mp > 8) return { ok: false, error: 'maxPlayers must be 1–8' }
      patch.maxPlayers = mp
    }
    if (fields.sessionDurationMs !== undefined) {
      const dur = Number(fields.sessionDurationMs)
      if (dur < 60_000) return { ok: false, error: 'sessionDurationMs must be >= 60000' }
      patch.sessionDurationMs = dur
    }
    if (fields.maxQueueSize !== undefined) {
      if (fields.maxQueueSize === null) {
        patch.maxQueueSize = null
      } else {
        const mqs = Number(fields.maxQueueSize)
        if (mqs < 1 || mqs > 200) return { ok: false, error: 'maxQueueSize must be 1–200' }
        patch.maxQueueSize = mqs
      }
    }

    await this.repo.update(id, patch)
    log.info({ totemId: id }, 'Totem updated')
    return { ok: true }
  }

  async deleteTotem(id) {
    const deleted = await this.repo.delete(id)
    if (!deleted) return { ok: false, error: 'Totem not found' }
    log.info({ totemId: id }, 'Totem deleted')
    return { ok: true }
  }
}
```

- [ ] **Step 5.2: Remover `currentSessionId`** de `src/modules/totem/totem.repository.js`: apagar a linha `currentSessionId:  null,` do `create()`, o método `setCurrentSession()` inteiro, e a linha `currentSessionId` do comentário de shape.

- [ ] **Step 5.3: Verificar sintaxe e commitar**

```bash
node --check src/modules/totem/totem.service.js
node --check src/modules/totem/totem.repository.js
git add src/modules/totem/totem.service.js src/modules/totem/totem.repository.js
git commit -m "refactor(totem): trim TotemService to pure CRUD, drop currentSessionId"
```

---

### Task 6: GameHandler — claim no connect

**Files:**
- Rewrite: `src/modules/game/game.handler.js`

- [ ] **Step 6.1: Substituir o arquivo inteiro** por:

```js
// src/modules/game/game.handler.js
// WebSocket lifecycle for player gamepads.
//   1. On connect: CLAIM the session via TotemQueueService (reserved → active)
//   2. Forward inputs to Redis Pub/Sub (game:input:{sessionId})
//   3. Send player_join via UDP so the game spawns/keeps the avatar
//   4. Heartbeat ping/pong to kill zombies
// Disconnect does NOT end the session (allows phone reconnection); sessions
// end via death/kick/timeout in TotemQueueService.

import { Channels, buildMessage, parseMessage } from '../../lib/channels.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('game.handler')

const HEARTBEAT_INTERVAL_MS = 15_000

export class GameHandler {
  constructor(fastify) {
    this.fastify    = fastify
    this.publisher  = fastify.redisPublisher
    this.subscriber = fastify.redisSubscriber

    /** @type {Map<WebSocket, { sessionId: string, playerId: string, alive: boolean }>} */
    this.connections = new Map()

    this._startHeartbeat()
    this._setupSubscriptions()
  }

  async onConnect(socket, request) {
    const { sessionId, playerId } = request.query
    if (!sessionId || !playerId) {
      socket.close(1008, 'Missing sessionId or playerId')
      return
    }

    const queue = this.fastify.totemQueue
    if (!queue) {
      socket.close(1011, 'Queue service unavailable')
      return
    }

    const claim = await queue.claim(sessionId, playerId)
    if (!claim.ok) {
      socket.close(1008, claim.error)
      return
    }
    const session = claim.session

    this.connections.set(socket, { sessionId, playerId, alive: true })
    log.info({ sessionId, playerId, total: this.connections.size }, 'Player connected')

    socket.on('message', (raw) => this.onMessage(socket, raw))
    socket.on('close',   ()    => this.onClose(socket))
    socket.on('pong',    ()    => this._markAlive(socket))
    socket.on('error',   (err) => log.error({ err: err.message, sessionId, playerId }, 'WS error'))

    const dispatcher = this.fastify.udpDispatcher
    if (dispatcher && session.totems?.length) {
      dispatcher.registerSession(sessionId, session.totems)
    }

    // Tell the game this player is in. pid is truncated to 8 chars — the
    // same convention the input dispatcher uses, so the game can key by it.
    const joinPacket = JSON.stringify({
      type: 'player_join',
      sid:  sessionId.slice(0, 8),
      pid:  playerId.slice(0, 8),
      tid:  session.totemId ?? null,
    })
    for (const t of session.totems ?? []) {
      this.fastify.udpSend(t.ip, t.udpPort, joinPacket).catch(err =>
        log.warn({ err: err.message, totemIp: t.ip }, 'UDP player_join send failed'))
    }

    await this._publish(Channels.sessionSync(sessionId), 'sync', sessionId, playerId, {
      event: 'player_connected', playerId,
    })
  }

  async onMessage(socket, raw) {
    const meta = this.connections.get(socket)
    if (!meta) return
    const { sessionId, playerId } = meta

    let parsed
    try {
      parsed = JSON.parse(raw.toString())
    } catch {
      log.warn({ sessionId, playerId }, 'Invalid message format — not JSON')
      return
    }

    const { action, state } = parsed
    if (!action || !state) {
      log.warn({ sessionId, playerId, parsed }, 'Message missing action or state')
      return
    }

    await this._publish(Channels.gameInput(sessionId), 'input', sessionId, playerId, { action, state })
  }

  async onClose(socket) {
    const meta = this.connections.get(socket)
    if (!meta) return
    const { sessionId, playerId } = meta
    this.connections.delete(socket)
    log.info({ sessionId, playerId, remaining: this.connections.size }, 'Player disconnected')

    // Session stays live — the phone may reconnect. The sweeper/timeout or a
    // death event is what actually frees the slot.
    await this._publish(Channels.sessionSync(sessionId), 'sync', sessionId, playerId, {
      event: 'player_disconnected', playerId,
    })
  }

  /** Forcibly closes the WS of a specific player (session ended). */
  disconnectPlayer(sessionId, playerId, code = 1008, reason = 'Session ended') {
    for (const [socket, meta] of this.connections) {
      if (meta.sessionId === sessionId && meta.playerId === playerId) {
        try { socket.close(code, reason) } catch { /* already closing */ }
        this.connections.delete(socket)
      }
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  async _publish(channel, type, sessionId, playerId, data) {
    if (!this.publisher) return
    try {
      await this.publisher.publish(channel, buildMessage(type, sessionId, playerId, data))
    } catch (err) {
      log.error({ err: err.message, channel }, 'Redis publish failed')
    }
  }

  _markAlive(socket) {
    const meta = this.connections.get(socket)
    if (meta) meta.alive = true
  }

  _startHeartbeat() {
    setInterval(() => {
      for (const [socket, meta] of this.connections) {
        if (!meta.alive) {
          log.warn({ sessionId: meta.sessionId, playerId: meta.playerId }, 'Heartbeat timeout — terminating')
          socket.terminate()
          this.connections.delete(socket)
          continue
        }
        meta.alive = false
        try { socket.ping() } catch { /* socket may already be closing */ }
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  /** Broadcasts game:event:* (e.g. session_ended) to that session's sockets. */
  _setupSubscriptions() {
    if (!this.subscriber) return

    this.subscriber.psubscribe('game:event:*').catch(err =>
      log.error({ err: err.message }, 'Failed to subscribe to game events'))

    this.subscriber.on('pmessage', (pattern, channel, raw) => {
      if (pattern !== 'game:event:*') return
      const msg = parseMessage(raw)
      if (!msg || msg.type !== 'event') return

      for (const [socket, meta] of this.connections.entries()) {
        if (meta.sessionId === msg.sessionId) {
          try { socket.send(raw) } catch (err) {
            log.error({ err: err.message, sessionId: msg.sessionId }, 'Failed to forward WS event')
          }
        }
      }
    })
  }
}
```

- [ ] **Step 6.2: Verificar sintaxe e commitar**

```bash
node --check src/modules/game/game.handler.js
git add src/modules/game/game.handler.js
git commit -m "feat(game): claim session on WS connect, send player_join via UDP"
```

---

### Task 7: totem.routes — rotas de fila no novo serviço

**Files:**
- Rewrite: `src/modules/totem/totem.routes.js`

- [ ] **Step 7.1: Substituir o arquivo inteiro** por:

```js
// src/modules/totem/totem.routes.js
// REST API for /api/totems: CRUD + queue endpoints (backed by TotemQueueService).

import fp     from 'fastify-plugin'
import QRCode from 'qrcode'
import { TotemService }      from './totem.service.js'
import { TotemQueueService } from './totemQueue.service.js'
import { createLogger }      from '../../lib/logger.js'
import { env }               from '../../config/env.js'
import { createRateLimiter } from '../../lib/rateLimit.js'

const log = createLogger('totem.routes')

const queueJoinRateLimit = createRateLimiter({ windowMs: 10_000, max: 8 })

const totemIdParam = {
  type:       'object',
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
  required:   ['id'],
}

const totemBodyProps = {
  name:              { type: 'string' },
  ip:                { type: 'string' },
  udpPort:           { type: 'number' },
  maxPlayers:        { type: 'number' },
  sessionDurationMs: { type: 'number' },
  maxQueueSize:      { type: 'number', nullable: true },
}

const totemResponseProps = {
  _id:               { type: 'string' },
  name:              { type: 'string' },
  ip:                { type: 'string' },
  udpPort:           { type: 'number' },
  maxPlayers:        { type: 'number', nullable: true },
  sessionDurationMs: { type: 'number', nullable: true },
  maxQueueSize:      { type: 'number', nullable: true },
  queueSize:         { type: 'number' },
}

const errorResponse = { type: 'object', properties: { error: { type: 'string' } } }

async function totemRoutes(fastify) {
  if (!fastify.mongo) {
    log.warn('MongoDB not available — totem routes disabled')
    return
  }

  const service = new TotemService(fastify.mongo, fastify.redisPublisher)
  const queue   = new TotemQueueService(fastify, service)
  fastify.decorate('totemQueue', queue)

  // Sweeper: expires no_show reservations and timed-out actives.
  const sweepTimer = setInterval(() => {
    queue.sweep().catch(err => log.error({ err: err.message }, 'Sweep failed'))
  }, env.queueSweepMs)
  fastify.addHook('onClose', () => clearInterval(sweepTimer))
  log.info({ sweepMs: env.queueSweepMs, reserveMs: env.queueReserveMs }, 'Queue sweeper started')

  // ── Queue SSE hub ──────────────────────────────────────────────────────────
  const queueSseClients = new Map() // totemId → Set<res>

  if (fastify.redisSubscriber) {
    fastify.redisSubscriber.psubscribe('queue:event:*').catch(err =>
      log.error({ err: err.message }, 'Failed to subscribe to queue events'))
    fastify.redisSubscriber.on('pmessage', (pattern, channel) => {
      if (pattern !== 'queue:event:*') return
      const totemId = channel.slice('queue:event:'.length)
      const clients = queueSseClients.get(totemId)
      if (!clients) return
      for (const res of clients) {
        try { res.write('data: {"type":"queue_changed"}\n\n') } catch { /* gone */ }
      }
    })
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  fastify.post('/api/totems', {
    schema: {
      tags: ['Totems'], summary: 'Create a new totem',
      body: { type: 'object', properties: totemBodyProps, required: ['name', 'ip', 'udpPort'] },
      response: {
        201: { type: 'object', properties: totemResponseProps },
        400: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { name, ip, udpPort, maxPlayers, sessionDurationMs, maxQueueSize } = request.body ?? {}
    const result = await service.createTotem({ name, ip, udpPort: Number(udpPort), maxPlayers, sessionDurationMs, maxQueueSize })
    if (!result.ok) return reply.status(400).send({ error: result.error })
    return reply.status(201).send(result.totem)
  })

  fastify.get('/api/totems', {
    schema: {
      tags: ['Totems'], summary: 'List all totems',
      response: { 200: { type: 'array', items: { type: 'object', properties: totemResponseProps } } },
    },
  }, async () => service.listTotems())

  fastify.get('/api/totems/:id', {
    schema: {
      tags: ['Totems'], summary: 'Get a totem by ID', params: totemIdParam,
      response: { 200: { type: 'object', properties: totemResponseProps }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    return totem
  })

  fastify.put('/api/totems/:id', {
    schema: {
      tags: ['Totems'], summary: 'Update a totem', params: totemIdParam,
      body: { type: 'object', properties: totemBodyProps },
      response: { 204: { type: 'null' }, 400: errorResponse, 404: errorResponse },
    },
  }, async (request, reply) => {
    const result = await service.updateTotem(request.params.id, request.body ?? {})
    if (!result.ok) {
      return reply.status(result.error === 'Totem not found' ? 404 : 400).send({ error: result.error })
    }
    return reply.status(204).send()
  })

  fastify.delete('/api/totems/:id', {
    schema: {
      tags: ['Totems'], summary: 'Delete a totem', params: totemIdParam,
      response: { 204: { type: 'null' }, 404: errorResponse },
    },
  }, async (request, reply) => {
    await queue.endAllForTotem(request.params.id, 'manual')
    await queue.clearQueue(request.params.id)
    const result = await service.deleteTotem(request.params.id)
    if (!result.ok) return reply.status(404).send({ error: result.error })
    return reply.status(204).send()
  })

  // ── Queue ──────────────────────────────────────────────────────────────────

  fastify.post('/api/totems/:id/queue/join', {
    preHandler: queueJoinRateLimit,
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Join totem: get own session or wait in line',
      params: totemIdParam,
      body: {
        type: 'object',
        properties: { playerId: { type: 'string' }, metadata: { type: 'object', additionalProperties: true } },
        required: ['playerId'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            status:          { type: 'string', enum: ['play', 'queue'] },
            sessionId:       { type: 'string' },
            position:        { type: 'number' },
            estimatedWaitMs: { type: 'number', nullable: true },
          },
        },
        404: errorResponse, 409: errorResponse, 429: errorResponse, 500: errorResponse, 503: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { playerId, metadata: clientMeta } = request.body
    const metadata = { ua: request.headers['user-agent'], ip: request.ip, ...(clientMeta || {}) }
    const result = await queue.join(request.params.id, playerId, metadata)
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    return result
  })

  fastify.get('/api/totems/:id/queue/status', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Player queue status (play | queue position)',
      params: totemIdParam,
      querystring: { type: 'object', properties: { playerId: { type: 'string' } }, required: ['playerId'] },
      response: {
        200: {
          type: 'object',
          properties: {
            status:          { type: 'string', enum: ['play', 'queue'] },
            sessionId:       { type: 'string' },
            position:        { type: 'number' },
            size:            { type: 'number' },
            estimatedWaitMs: { type: 'number', nullable: true },
          },
        },
        404: errorResponse, 500: errorResponse,
      },
    },
  }, async (request, reply) => {
    const result = await queue.status(request.params.id, request.query.playerId)
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    return result
  })

  fastify.get('/api/totems/:id/queue', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Operator view: live sessions + waiting list',
      params: totemIdParam,
      response: {
        200: {
          type: 'object',
          properties: {
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string' },
                  playerId:  { type: 'string' },
                  status:    { type: 'string' },
                  metadata:  { type: 'object', additionalProperties: true, nullable: true },
                  createdAt: { type: 'string' },
                  expiresAt: { type: 'string' },
                },
              },
            },
            queue: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id:              { type: 'string' },
                  metadata:        { type: 'object', additionalProperties: true, nullable: true },
                  heartbeatTtl:    { type: 'number', nullable: true },
                  estimatedWaitMs: { type: 'number', nullable: true },
                },
              },
            },
            maxPlayers:   { type: 'number' },
            maxQueueSize: { type: 'number', nullable: true },
          },
        },
        404: errorResponse,
      },
    },
  }, async (request, reply) => {
    const result = await queue.operatorView(request.params.id)
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    const { ok, ...view } = result
    return view
  })

  fastify.get('/api/totems/:id/queue/events', {
    schema: { tags: ['Totems', 'Queue'], summary: 'SSE stream of queue change pings', params: totemIdParam },
  }, async (request, reply) => {
    const { id } = request.params
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    reply.raw.write('data: {"type":"connected"}\n\n')

    if (!queueSseClients.has(id)) queueSseClients.set(id, new Set())
    queueSseClients.get(id).add(reply.raw)

    const heartbeat = setInterval(() => {
      try { reply.raw.write(': ping\n\n') } catch { /* gone */ }
    }, 20_000)

    request.raw.on('close', () => {
      clearInterval(heartbeat)
      queueSseClients.get(id)?.delete(reply.raw)
    })
  })

  fastify.delete('/api/totems/:id/queue/:playerId', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Remove a player from the waiting list',
      params: {
        type: 'object',
        properties: {
          id:       { type: 'string', minLength: 36, maxLength: 36 },
          playerId: { type: 'string', minLength: 1 },
        },
        required: ['id', 'playerId'],
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    await queue.kickFromQueue(request.params.id, request.params.playerId)
    log.info({ totemId: request.params.id, playerId: request.params.playerId }, 'Player kicked from queue')
    return { ok: true }
  })

  fastify.post('/api/totems/:id/queue/clear', {
    schema: {
      tags: ['Totems', 'Queue'], summary: 'Clear the waiting list (live sessions untouched)',
      params: totemIdParam,
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })
    await queue.clearQueue(request.params.id)
    return { ok: true }
  })

  // ── Game integration ───────────────────────────────────────────────────────
  // With playerId (from the game, possibly truncated to 8 chars): ends only
  // that player's session. Without: ends every session of the totem (reset).
  fastify.post('/api/totems/:id/end-session', {
    schema: {
      tags: ['Totems'], summary: "End one player's session (game death) or all sessions (reset)",
      params: totemIdParam,
      body: { type: 'object', properties: { playerId: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            ok:             { type: 'boolean' },
            endedSessionId: { type: 'string', nullable: true },
            endedCount:     { type: 'number', nullable: true },
          },
        },
        404: errorResponse, 500: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const totem = await service.findTotem(id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    const { playerId } = request.body || {}
    if (playerId) {
      const session = await queue.findCurrentByPidPrefix(id, playerId)
      if (!session) return reply.status(404).send({ error: 'No live session for this player' })
      const result = await queue.endSession(session._id, 'died')
      if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
      log.info({ totemId: id, playerId, sessionId: session._id }, 'Player died — session ended')
      return { ok: true, endedSessionId: session._id }
    }

    const result = await queue.endAllForTotem(id, 'manual')
    log.info({ totemId: id, endedCount: result.endedCount }, 'All sessions ended (operator reset)')
    return { ok: true, endedCount: result.endedCount }
  })

  // ── QR ─────────────────────────────────────────────────────────────────────
  fastify.get('/api/totems/:id/qr', {
    schema: {
      tags: ['Totems'], summary: 'Get totem QR code', params: totemIdParam,
      querystring: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'dataurl'] } } },
      response: { 404: errorResponse },
    },
  }, async (request, reply) => {
    const totem = await service.findTotem(request.params.id)
    if (!totem) return reply.status(404).send({ error: 'Totem not found' })

    const entryUrl = `${env.publicUrl}/play/totem?id=${request.params.id}`
    if ((request.query.format ?? 'png') === 'dataurl') {
      const dataUrl = await QRCode.toDataURL(entryUrl, { width: 300, margin: 2 })
      return { totemId: request.params.id, entryUrl, qr: dataUrl }
    }
    const buffer = await QRCode.toBuffer(entryUrl, { type: 'png', width: 300, margin: 2 })
    reply.header('Content-Type', 'image/png')
    reply.header('Cache-Control', 'public, max-age=3600')
    return reply.send(buffer)
  })
}

export default fp(totemRoutes, {
  name:         'totem-routes',
  dependencies: ['mongodb'],
})
```

**Removidos:** `GET /api/totems/:id/session` (legado), `totemSessionLock` nas rotas (o serviço é dono do lock), `estimateWait` local (movido pro serviço).

- [ ] **Step 7.2: Verificar sintaxe e commitar**

```bash
node --check src/modules/totem/totem.routes.js
git add src/modules/totem/totem.routes.js
git commit -m "feat(queue): totem routes on TotemQueueService, drop legacy /session"
```

---

### Task 8: session.routes — enxuta; deletar session.service.js

**Files:**
- Rewrite: `src/modules/session/session.routes.js`
- Delete: `src/modules/session/session.service.js`

- [ ] **Step 8.1: Confirmar que nada mais importa SessionService**

Run: `grep -rn "session.service" src/ --include="*.js"`
Expected: apenas `src/modules/session/session.routes.js` (que será reescrito).

- [ ] **Step 8.2: Substituir `session.routes.js` inteiro** por:

```js
// src/modules/session/session.routes.js
// Read/end operations on per-player sessions. Sessions are CREATED only by
// TotemQueueService (queue/join) — there is no create route anymore.
// Ending goes through fastify.totemQueue so the freed slot advances the queue.

import fp     from 'fastify-plugin'
import QRCode from 'qrcode'
import { SessionRepository } from './session.repository.js'
import { createLogger }      from '../../lib/logger.js'
import { env }               from '../../config/env.js'

const log = createLogger('session.routes')

const sessionIdParam = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 36, maxLength: 36 } },
  required: ['id'],
}

const errorResponse = { type: 'object', properties: { error: { type: 'string' } } }

const sessionShape = {
  type: 'object',
  properties: {
    sessionId: { type: 'string' },
    totemId:   { type: 'string', nullable: true },
    playerId:  { type: 'string' },
    status:    { type: 'string' },
    createdAt: { type: 'string' },
    expiresAt: { type: 'string' },
    endedAt:   { type: 'string', nullable: true },
    endReason: { type: 'string', nullable: true },
  },
}

function toDto(s) {
  return {
    sessionId: s._id,
    totemId:   s.totemId ?? null,
    playerId:  s.playerId,
    status:    s.status,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    endedAt:   s.endedAt ?? null,
    endReason: s.endReason ?? null,
  }
}

async function sessionRoutes(fastify) {
  if (!fastify.mongo) {
    log.warn('MongoDB not available — session routes disabled')
    return
  }

  const repo = new SessionRepository(fastify.mongo)

  fastify.get('/api/sessions', {
    schema: {
      tags: ['Sessions'], summary: 'List live (reserved/active) sessions',
      response: { 200: { type: 'array', items: sessionShape } },
    },
  }, async () => {
    const sessions = await repo.listCurrentAll()
    return sessions.map(toDto)
  })

  fastify.get('/api/sessions/:id', {
    schema: {
      tags: ['Sessions'], summary: 'Get a session by ID', params: sessionIdParam,
      response: { 200: sessionShape, 404: errorResponse },
    },
  }, async (request, reply) => {
    const session = await repo.findById(request.params.id)
    if (!session) return reply.status(404).send({ error: 'Session not found' })
    return toDto(session)
  })

  fastify.post('/api/sessions/:id/end', {
    schema: {
      tags: ['Sessions'], summary: "End a player's session (frees the slot, queue advances)",
      params: sessionIdParam,
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const result = await fastify.totemQueue.endSession(request.params.id, 'manual')
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    return { ok: true }
  })

  // Kept for URL compatibility with the dashboard — same effect as /end.
  fastify.post('/api/sessions/:id/players/:playerId/kick', {
    schema: {
      tags: ['Sessions'], summary: 'Kick the player (ends their session, queue advances)',
      params: {
        type: 'object',
        properties: { id: { type: 'string' }, playerId: { type: 'string' } },
        required: ['id', 'playerId'],
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const result = await fastify.totemQueue.endSession(request.params.id, 'kicked')
    if (!result.ok) return reply.status(result.code ?? 500).send({ error: result.error })
    return { ok: true }
  })

  fastify.delete('/api/sessions/:id', {
    schema: {
      tags: ['Sessions'], summary: 'Hard delete a session (admin)', params: sessionIdParam,
      response: { 204: { type: 'null' }, 404: errorResponse },
    },
  }, async (request, reply) => {
    await fastify.totemQueue.endSession(request.params.id, 'manual').catch(() => {})
    const deleted = await repo.delete(request.params.id)
    if (!deleted) return reply.status(404).send({ error: 'Session not found' })
    return reply.status(204).send()
  })

  fastify.get('/api/sessions/:id/qr', {
    schema: {
      tags: ['Sessions'], summary: 'QR code for the play page', params: sessionIdParam,
      querystring: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'dataurl'] } } },
      response: { 404: errorResponse },
    },
  }, async (request, reply) => {
    const session = await repo.findById(request.params.id)
    if (!session) return reply.status(404).send({ error: 'Session not found' })

    const playUrl = `${env.publicUrl}/play/${request.params.id}`
    if ((request.query.format ?? 'png') === 'dataurl') {
      return { sessionId: request.params.id, playUrl, qr: await QRCode.toDataURL(playUrl, { width: 300, margin: 2 }) }
    }
    const buffer = await QRCode.toBuffer(playUrl, { type: 'png', width: 300, margin: 2 })
    reply.header('Content-Type', 'image/png')
    return reply.send(buffer)
  })
}

export default fp(sessionRoutes, {
  name:         'session-routes',
  dependencies: ['mongodb'],
})
```

**Removidos:** `POST /api/sessions` (create), `/join`, `/player-died`, watcher de timeout (substituído pelo sweeper do TotemQueueService).

- [ ] **Step 8.3: Deletar o service e conferir referências**

```bash
rm src/modules/session/session.service.js
grep -rn "SessionService\|sessionService" src/ --include="*.js"
```
Expected: nenhuma ocorrência.

- [ ] **Step 8.4: Verificar boot completo**

Run: `node --check src/modules/session/session.routes.js && timeout 8 node src/server.js 2>&1 | head -30`
Expected: servidor sobe sem erro, loga "Queue sweeper started".

- [ ] **Step 8.5: Commit**

```bash
git add -A src/modules/session/
git commit -m "refactor(session): routes read/end only; delete SessionService"
```

---

### Task 9: e2e GREEN

- [ ] **Step 9.1: Rodar o e2e**

Run: `npm run test:e2e`
Expected: `ALL SCENARIOS PASSED`, exit 0.

- [ ] **Step 9.2: Se falhar** — debugar cenário a cenário (o script imprime cada FAIL com a mensagem do assert). Correções vão nos arquivos das Tasks 2–8. Repetir até verde.

- [ ] **Step 9.3: Commit** (se houve correções)

```bash
git add -A src/ tests/
git commit -m "fix(queue): make e2e scenarios pass"
```

---

### Task 10: demo-snake — player_join/player_leave

**Files:**
- Modify: `demo-snake/public/game.js`

- [ ] **Step 10.1:** Em `demo-snake/public/game.js`, no `evtSource.onmessage`, **substituir** o bloco:

```js
    if (data.type === 'session_start') {
      // Nova sessão iniciada — reseta o estado de gameOver de todos os jogadores
      Object.keys(players).forEach(k => delete players[k]);
      colorIndex = 0;
      return;
    }
```

por:

```js
    // Jogadores entram e saem individualmente — nunca há reset de board.
    if (data.type === 'player_join') {
      console.log('[SSE] player_join:', data.pid);
      if (data.tid) currentTotemId = data.tid;
      return;
    }

    if (data.type === 'player_leave') {
      console.log('[SSE] player_leave:', data.pid);
      delete players[data.pid];
      updateScoreboard();
      return;
    }
```

- [ ] **Step 10.2:** No mesmo arquivo, **remover** o bloco de respawn (a sessão do morto já era — os controles dele desconectam):

```js
    if (!p.alive && action === 'btn_A' && state === 1) {
      if (!p.gameOver) addPlayer(pid);
    }
```

- [ ] **Step 10.3:** Em `demo-snake/server.js`, no handler UDP, trocar a condição `if (data.type === 'session_start')` por `if (data.type === 'player_join')` (mesma lógica de aprender `tid`; atualizar o texto do log para `Player join — totem: ...`).

- [ ] **Step 10.4:** Atualizar `demo-snake/README.md`: remover a linha "Caso o jogador morra, aperte o botão A no celular para dar Respawn." e substituir por "Caso o jogador morra, sua sessão é encerrada e o próximo da fila assume a vaga."

- [ ] **Step 10.5: Verificar e commitar**

```bash
node --check demo-snake/server.js && node --check demo-snake/public/game.js
git add demo-snake/
git commit -m "feat(demo-snake): handle player_join/player_leave, drop board reset"
```

---

### Task 11: play page — tela de fim + voltar pra fila

**Files:**
- Modify: `public/session.js`

- [ ] **Step 11.1:** Em `public/session.js`:

a) No `boot(sid)`, a resposta de `GET /api/sessions/:id` agora traz `totemId` e `status` — guardar o totemId e aceitar `reserved`:

Substituir:
```js
  if (session.status === 'finished') {
    return showError('Esta sessão já foi encerrada.')
  }
```
por:
```js
  const totemId = session.totemId

  if (session.status === 'finished') {
    return showEnded(totemId)
  }
```

b) Substituir os dois pontos de encerramento (`onClose` código 1008 e `handleServerEvent` com `session_ended`):

```js
    onClose(code) {
      setConnected(false)
      if (code === 1008) {
        destroyAll()
        showEnded(totemId)
      }
    },
```
e
```js
  function handleServerEvent(data) {
    if (data?.data?.event === 'session_ended') {
      destroyAll()
      showEnded(totemId)
    }
  }
```

c) Adicionar `showEnded` ao lado de `showError` (injeta o botão sem precisar mudar o play.html):

```js
function showEnded(totemId) {
  showError('Sua sessão acabou. Obrigado por jogar!')
  if (!totemId) return
  if (document.getElementById('play-again-btn')) return

  const btn = document.createElement('button')
  btn.id = 'play-again-btn'
  btn.textContent = '🎮 Jogar novamente'
  btn.style.cssText = 'margin-top:16px;padding:12px 28px;font-size:16px;font-weight:700;' +
    'background:#3b82f6;color:#fff;border:none;border-radius:10px;cursor:pointer;'
  btn.addEventListener('click', () => {
    window.location.href = `/play/totem?id=${totemId}`
  })
  $error.appendChild(btn)
}
```

- [ ] **Step 11.2: Verificar e commitar**

```bash
node --check public/session.js
git add public/session.js
git commit -m "feat(play): session-ended screen with play-again button"
```

---

### Task 12: dashboard — ocupação X/N e modal por sessões

**Files:**
- Modify: `public/dashboard.js`

- [ ] **Step 12.1: Card de status.** Substituir `fetchSessionStatus` e `startSessionPoll` (o legado `GET /:id/session` morreu; a fonte agora é `GET /:id/queue`):

```js
async function fetchTotemState(totemId) {
  try {
    const res = await fetch(`${API}/${totemId}/queue`)
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

function startSessionPoll(totem, card) {
  const render = async () => {
    const area = card.querySelector('[data-status-area]')
    if (!area) return

    const data = await fetchTotemState(totem._id)
    if (!data) {
      area.innerHTML = '<span class="session-badge badge-inactive">⚫ Indisponível</span>'
      return
    }

    const { sessions = [], maxPlayers = totem.maxPlayers ?? 2 } = data
    const active = sessions.filter(s => s.status === 'active').length
    const reserved = sessions.filter(s => s.status === 'reserved').length

    if (sessions.length === 0) {
      area.innerHTML = '<span class="session-badge badge-inactive">⚫ Livre</span>'
      return
    }

    area.innerHTML = `
      <span class="session-badge badge-active">🟢 ${active}/${maxPlayers} jogando${reserved ? ` · ${reserved} reservado(s)` : ''}</span>
      <button class="btn-end-session" data-totem-id="${escHtml(totem._id)}">Encerrar Todas</button>
    `
    area.querySelector('.btn-end-session')?.addEventListener('click', async () => {
      await endAllSessions(totem._id, totem.name)
      await render()
    })
  }

  render()
  sessionPollTimers[totem._id] = setInterval(render, 15_000)
}

async function endAllSessions(totemId, totemName) {
  const result = await Swal.fire({
    title:              `Encerrar TODAS as sessões de "${escHtml(totemName)}"?`,
    text:               'Todos os jogadores atuais serão desconectados e a fila avançará.',
    icon:               'warning',
    showCancelButton:   true,
    confirmButtonColor: '#ef4444',
    cancelButtonColor:  '#64748b',
    confirmButtonText:  'Sim, encerrar',
    cancelButtonText:   'Cancelar',
    reverseButtons:     true,
    focusCancel:        true,
  })
  if (!result.isConfirmed) return

  try {
    const res = await fetch(`${API}/${totemId}/end-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (!res.ok) throw new Error(`Erro ${res.status}`)
    Swal.fire({ title: 'Encerradas!', icon: 'success', timer: 1800, showConfirmButton: false })
  } catch (err) {
    showTotemError(`Erro ao encerrar sessões: ${err.message}`)
  }
}
```

Remover a antiga `endSession(sessionId, totemName)` e a antiga `fetchSessionStatus`.

- [ ] **Step 12.2: Modal de fila.** Em `renderQueueModal`, o payload agora é `{ sessions, queue, maxPlayers, maxQueueSize }`. Substituir a desestruturação e o bloco `playerRows`:

```js
  const { sessions = [], queue = [], maxQueueSize = null } = data
  const queueCapLabel = maxQueueSize ? ` / ${maxQueueSize}` : ''

  if (sessions.length === 0 && queue.length === 0) {
    queueModalBody.innerHTML = `<div class="queue-panel"><div class="queue-panel-header"><span>Controle de Fila</span><span class="queue-count">Vazio</span></div></div>`
    return
  }

  const playerRows = sessions.map((s) => {
    const pidStr = String(s.playerId)
    const shortId = pidStr.length > 14 ? pidStr.slice(0, 14) : pidStr
    const metaHtml = formatDeviceMeta(s.metadata)
    const badge = s.status === 'active' ? '🎮' : '⏳'
    const shortSid = String(s.sessionId).slice(0, 8)
    return `
      <div class="queue-row queue-row--playing">
        <span class="queue-pos">${badge}</span>
        <div style="flex: 1; min-width: 0;">
          <div class="queue-pid" title="${escHtml(pidStr)}">${escHtml(shortId)}${pidStr.length > 14 ? '…' : ''}</div>
          ${metaHtml}
          <div class="queue-device-meta" title="${escHtml(String(s.sessionId))}">🆔 sessão ${escHtml(shortSid)}… · ${s.status === 'active' ? 'jogando' : 'reservada'}</div>
        </div>
        <button class="btn-kick" data-session-id="${escHtml(String(s.sessionId))}" data-player-id="${escHtml(pidStr)}" title="Encerrar a sessão deste jogador">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Expulsar
        </button>
      </div>`
  }).join('')
```

No header do painel, trocar `${sessionPlayers.length} jogando` por `${sessions.length} jogando`. No handler dos `.btn-kick`: se `btn.dataset.sessionId` existe → `kickFromSession(sid, pid, totem.name)` (que já chama `/api/sessions/:sid/players/:pid/kick`); senão → `kickFromQueue` (fila, inalterado). As linhas da fila (`queueRows`) não mudam.

- [ ] **Step 12.3: Verificar e commitar**

```bash
node --check public/dashboard.js
git add public/dashboard.js
git commit -m "feat(dashboard): per-player sessions in card and queue modal"
```

---

### Task 13: Docs + verificação final

**Files:**
- Modify: `CLAUDE.md` (seções: Schemas MongoDB, State Machine, Fluxo do Jogador, APIs REST, Redis Keys)
- Modify: `prd.md` (mesmas seções)

- [ ] **Step 13.1:** Atualizar `CLAUDE.md` e `prd.md`: schema de sessão novo (playerId, reserved/active/finished, reservedUntil, sem players[]/allowedPlayers), remoção de `currentSessionId` do totem, rotas removidas (`/session` legado, `POST /api/sessions`, `/join`, `/player-died`), rota `end-session` (com/sem playerId), state machine `reserved → active → finished`, protocolo UDP `player_join`/`player_leave`, fluxo do jogador atualizado.

- [ ] **Step 13.2: e2e final**

Run: `npm run test:e2e`
Expected: `ALL SCENARIOS PASSED`

- [ ] **Step 13.3: Lint**

Run: `npm run lint`
Expected: sem erros novos (warnings pré-existentes ok).

- [ ] **Step 13.4: Commit final**

```bash
git add CLAUDE.md prd.md
git commit -m "docs: update for per-player session queue model"
```

---

## Self-Review (executada na escrita do plano)

- **Spec coverage:** modelo por-jogador (T2–T4), 30s no_show (T1 env + T4 sweep + cenário 5), tela fim+botão (T11), TotemQueueService único dono (T4), demo-snake player_leave (T10), rotas (T7–T8), dashboard (T12), remoções (T5, T7, T8, T10). ✔
- **Pid truncado:** convenção documentada; `findCurrentByPidPrefix` cobre o caminho jogo→backend; cenário 4 testa com pid cortado. ✔
- **Deadlock do mutex:** documentado na Task 4 — métodos `_xxxLocked` nunca re-lockam; `endAllForTotem`/`sweep` chamam `endSession` fora de lock. ✔
- **Dispatcher intocado:** cache mantém campo `totems`; `registerSession`/`unregisterSession` chamados por handler/queue service. ✔
