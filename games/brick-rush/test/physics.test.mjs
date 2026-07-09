// games/brick-rush/test/physics.test.mjs
// The BFS validator (wfc.js) assumes a movement envelope of dx≤4 / dy≤3 tiles.
// This test simulates the REAL physics in a flat room and asserts the player
// can actually do that (and a bit more) — if physics ever gets nerfed below
// the validator's assumptions, this fails before players get stuck in maps.
// Run: node games/brick-rush/test/physics.test.mjs

import assert from 'node:assert/strict'
import { createPlayer, step } from '../public/physics.js'
import { T, W, H, TILE } from '../public/maps.js'

// Flat test room: solid floor at row 18, solid borders, one wall column for
// the wall-jump test.
function makeRoom({ wallX = null } = {}) {
  const grid = new Uint8Array(W * H)
  for (let x = 0; x < W; x++) {
    grid[19 * W + x] = T.BLOCK           // floor
    grid[0 * W + x] = T.BLOCK
    grid[(H - 1) * W + x] = T.BLOCK
  }
  for (let y = 0; y < H; y++) {
    grid[y * W + 0] = T.BLOCK
    grid[y * W + (W - 1)] = T.BLOCK
  }
  if (wallX !== null) {
    for (let y = 8; y < 19; y++) grid[y * W + wallX] = T.BLOCK
  }
  return { grid, movers: [], theme: { gimmick: {} } }
}

const DT = 1 / 120 // fixed small step for determinism

function simulate(map, player, inputScript, maxMs = 3000) {
  const trace = { maxRise: 0, maxDx: 0 }
  const startX = player.x
  const startY = player.y
  let now = 0
  for (let t = 0; t < maxMs; t += DT * 1000) {
    now = t
    inputScript(player, t)
    step(player, map, map.theme.gimmick, DT, now)
    trace.maxRise = Math.max(trace.maxRise, startY - player.y)
    trace.maxDx = Math.max(trace.maxDx, Math.abs(player.x - startX))
  }
  return trace
}

// ── 1. Jump height ≥ 3 tiles ─────────────────────────────────────────────────
{
  const map = makeRoom()
  const p = createPlayer('t1', '#fff', { x: 10 * TILE, y: 18 * TILE + TILE / 2 })
  const trace = simulate(map, p, (pl, t) => {
    pl.input.jump = t < 400
    pl.input.jumpEdge = t < 20
  }, 1200)
  assert.ok(trace.maxRise >= 3 * TILE, `pulo sobe ${(trace.maxRise / TILE).toFixed(2)} tiles (< 3)`)
  console.log(`OK  pulo: ${(trace.maxRise / TILE).toFixed(2)} tiles de altura`)
}

// ── 2. Jump horizontal reach ≥ 4 tiles ───────────────────────────────────────
{
  const map = makeRoom()
  const p = createPlayer('t2', '#fff', { x: 10 * TILE, y: 18 * TILE + TILE / 2 })
  const trace = simulate(map, p, (pl, t) => {
    pl.input.right = true
    pl.input.jump = t < 400
    pl.input.jumpEdge = t < 20
  }, 1500)
  assert.ok(trace.maxDx >= 4 * TILE, `pulo alcança ${(trace.maxDx / TILE).toFixed(2)} tiles (< 4)`)
  console.log(`OK  alcance: ${(trace.maxDx / TILE).toFixed(2)} tiles no pulo corrido`)
}

// ── 3. Wall-jump gains ≥ 2 tiles above the grab point ────────────────────────
{
  const map = makeRoom({ wallX: 12 })
  // player pressed against the wall, falling
  const p = createPlayer('t3', '#fff', { x: 11 * TILE + 16, y: 14 * TILE })
  p.vy = 200 // already falling → wall-slide engages
  let grabbedY = null
  let maxRiseAfterGrab = 0
  let jumped = false
  const trace = { }
  let now = 0
  for (let t = 0; t < 2000; t += DT * 1000) {
    now = t
    p.input.right = !jumped          // push into the wall until we jump
    if (p.wallDir !== 0 && !jumped) {
      grabbedY = grabbedY ?? p.y
      p.input.jump = true
      p.input.jumpEdge = true
      jumped = true
    } else {
      p.input.jumpEdge = false
    }
    step(p, map, {}, DT, now)
    if (grabbedY !== null) maxRiseAfterGrab = Math.max(maxRiseAfterGrab, grabbedY - p.y)
  }
  assert.ok(jumped, 'wall grab nunca aconteceu')
  assert.ok(maxRiseAfterGrab >= 2 * TILE, `wall-jump sobe ${(maxRiseAfterGrab / TILE).toFixed(2)} tiles (< 2)`)
  console.log(`OK  wall-jump: ${(maxRiseAfterGrab / TILE).toFixed(2)} tiles acima do grab`)
}

// ── 4. Dash covers ≥ 2.5 tiles ───────────────────────────────────────────────
{
  const map = makeRoom()
  const p = createPlayer('t4', '#fff', { x: 10 * TILE, y: 18 * TILE + TILE / 2 })
  p.facing = 1
  const trace = simulate(map, p, (pl, t) => {
    pl.input.dash = t < 50
    pl.input.dashEdge = t < 20
  }, 800)
  assert.ok(trace.maxDx >= 2.5 * TILE, `dash percorre ${(trace.maxDx / TILE).toFixed(2)} tiles (< 2.5)`)
  console.log(`OK  dash: ${(trace.maxDx / TILE).toFixed(2)} tiles`)
}

// ── 5. Hazard kills and respawn timer works ──────────────────────────────────
{
  const map = makeRoom()
  map.grid[18 * W + 15] = T.HAZARD
  const p = createPlayer('t5', '#fff', { x: 15 * TILE + 8, y: 18 * TILE + 8 })
  step(p, map, {}, DT, 1000)
  assert.ok(p.deadUntil > 1000, 'hazard não matou')
  console.log('OK  hazard mata e agenda respawn')
}

console.log('ALL PHYSICS TESTS PASSED')
