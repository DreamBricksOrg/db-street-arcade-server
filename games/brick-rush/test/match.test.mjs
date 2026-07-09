// games/brick-rush/test/match.test.mjs
// Headless smoke test of the match state machine: 3 players join, the match
// runs all 3 rounds (players teleported to the brick to finish), placement
// and round points come out right. No DOM, no network (fetch stubbed).
// Run: node games/brick-rush/test/match.test.mjs

import assert from 'node:assert/strict'
import { createMatch } from '../public/match.js'

// Stub fetch: rotation calls /queue-state and /end-session.
const endSessionCalls = []
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('queue-state')) {
    return { json: async () => ({ queue: ['q1', 'q2'], sessions: [], maxPlayers: 3 }) }
  }
  if (String(url).includes('end-session')) {
    endSessionCalls.push(JSON.parse(opts.body).pid)
    return { json: async () => ({ ok: true }) }
  }
  return { json: async () => ({}) }
}

const match = createMatch()
match.setQueueState({ queue: [], maxPlayers: 3 })

let now = 1000
const DT = 1 / 60
const tick = (ms) => {
  for (let t = 0; t < ms; t += DT * 1000) {
    now += DT * 1000
    match.tick(now, DT)
  }
}

// ── Lobby: 3 players join → full → countdown ─────────────────────────────────
match.onPlayerJoin('p1', now)
match.onPlayerJoin('p2', now)
match.onPlayerJoin('p3', now)
tick(100)
assert.equal(match.phase, 'countdown', `lobby cheio deveria ir pro countdown, está em ${match.phase}`)

tick(3100)
assert.equal(match.phase, 'round')
assert.equal(match.round, 1)
assert.ok(match.map, 'mapa do round 1 gerado')

// ── Rounds: teleport players onto the brick in placement order ──────────────
function finishRound(order) {
  for (const pid of order) {
    const p = match.players.get(pid)
    p.x = match.map.brick.x
    p.y = match.map.brick.y
    p.vx = 0; p.vy = 0
    tick(60) // let the pickup register (order matters)
  }
  // all finished → roundEnd fires immediately (no need to wait out the grace)
  tick(200)
  assert.equal(match.phase, 'roundEnd', `esperava roundEnd, está em ${match.phase}`)
  tick(5_200) // roundEnd screen expires → next round or matchEnd
}

finishRound(['p1', 'p2', 'p3']) // round 1: p1=5, p2=3, p3=2
assert.equal(match.round, 2)
finishRound(['p1', 'p3', 'p2']) // round 2: p1=10, p3=5, p2=6... (p3+3=5, p2+2=8? não: p2 chega 3º=+2 → 5+? )
finishRound(['p2', 'p1', 'p3']) // round 3

// Totais: p1 = 5+5+3 = 13; p2 = 3+2+5 = 10; p3 = 2+3+2 = 7
const p1 = match.players.get('p1'), p2 = match.players.get('p2'), p3 = match.players.get('p3')
assert.equal(p1.points, 13, `p1 pontos: ${p1.points}`)
assert.equal(p2.points, 10, `p2 pontos: ${p2.points}`)
assert.equal(p3.points, 7,  `p3 pontos: ${p3.points}`)

// ── Match end → rotation: TODOS são expulsos, inclusive o vencedor ──────────
assert.equal(match.phase, 'matchEnd', `esperava matchEnd, está em ${match.phase}`)
tick(8_100)
assert.equal(match.phase, 'rotation')
tick(200) // deixa o _startRotation assíncrono resolver
await new Promise(r => setTimeout(r, 50))
tick(100)

assert.deepEqual(endSessionCalls.sort(), ['p1', 'p2', 'p3'], `eliminados: ${endSessionCalls}`)

// player_leave dos eliminados chega via SSE → rotação conclui → lobby vazio
match.onPlayerLeave('p1', now)
match.onPlayerLeave('p2', now)
match.onPlayerLeave('p3', now)
tick(100)
assert.equal(match.phase, 'lobby', `esperava lobby, está em ${match.phase}`)
assert.equal(match.players.size, 0, 'ninguém permanece — todos reconectam pela fila')
assert.equal(match.winStreakPid, 'p1', 'campeão lembrado no HUD do lobby')

// ── Config custom: 2 rounds ──────────────────────────────────────────────────
const m2 = createMatch()
m2.setConfig({ rounds: 2, roundMs: 60_000, graceMs: 5_000, lobbyWaitMs: 10_000 })
assert.equal(m2.cfg.rounds, 2)
assert.equal(m2.cfg.roundMs, 60_000)

// ── Input de pid desconhecido no lobby vira join (pacote player_join perdido) ─
const m3 = createMatch()
m3.setQueueState({ queue: [], maxPlayers: 3 })
m3.onInput('ghost_p', 'dpad_left', 1, now)
assert.ok(m3.players.has('ghost_p'), 'input de desconhecido registra o jogador no lobby')

console.log('ALL MATCH FSM TESTS PASSED')
