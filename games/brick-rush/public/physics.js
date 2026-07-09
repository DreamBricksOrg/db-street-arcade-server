// games/brick-rush/public/physics.js
// Platformer physics for Brick Rush: AABB vs tile grid, run/jump/wall-jump/
// dash, moving platforms and the per-theme gimmicks. Pure logic — no DOM.
//
// The movement envelope here MUST cover what the map validator assumes
// (wfc.js: jump dx≤4 / dy≤3 tiles). physics.test.mjs enforces that.

import { T, W, H, TILE } from './maps.js'

// ── Tuning constants ─────────────────────────────────────────────────────────
export const GRAV        = 2200  // px/s²
export const MOVE_SPEED  = 260   // px/s target run speed
export const ACCEL       = 2600  // px/s² ground acceleration
export const AIR_ACCEL   = 1800  // px/s² air control
export const FRICTION    = 0.15  // ground velocity damping factor (per frame @60fps)
export const SLIP_FRICTION = 0.02 // damping ON SLIP tiles (ice/sand) — slide happens only there
export const JUMP_V      = 680   // px/s initial jump velocity
export const WALL_SLIDE  = 90    // px/s max fall speed while wall-sliding
export const WALL_JUMP_VX = 340
export const WALL_JUMP_VY = 620
export const DASH_V      = 640   // px/s during dash
export const DASH_MS     = 150
export const DASH_CD_MS  = 3000
export const COYOTE_MS   = 100
export const JUMP_BUFFER_MS = 100
export const MAX_FALL    = 900  // px/s terminal velocity
export const RESPAWN_MS  = 3000

export function createPlayer(pid, color, spawn) {
  return {
    pid, color,
    x: spawn.x, y: spawn.y,
    vx: 0, vy: 0,
    w: 22, h: 30,
    onGround: false,
    wallDir: 0,            // -1 wall on left, 1 wall on right, 0 none
    facing: 1,
    lastGroundAt: -1e9,    // for coyote time
    jumpBufferedAt: -1e9,  // for jump buffer
    dashUntil: 0,
    dashCdUntil: 0,
    dashDir: 1,
    deadUntil: 0,
    spawn: { ...spawn },
    finishedAt: null,      // set by match.js when the brick is touched
    left: false,           // player_leave marker (match.js)
    points: 0,
    roundPoints: 0,
    totalCaptureMs: 0,
    joinedAt: 0,
    winStreak: 0,
    input: { left: false, right: false, down: false, jump: false, dash: false, jumpEdge: false, dashEdge: false },
  }
}

/** Resets position/motion for a new round (keeps score). */
export function resetForRound(player, spawn, now) {
  player.x = spawn.x
  player.y = spawn.y
  player.spawn = { ...spawn }
  player.vx = 0
  player.vy = 0
  player.deadUntil = 0
  player.dashUntil = 0
  player.dashCdUntil = 0
  player.finishedAt = null
  player.roundPoints = 0
}

export function kill(player, now) {
  player.deadUntil = now + RESPAWN_MS
  player.vx = 0
  player.vy = 0
}

// ── Main step ────────────────────────────────────────────────────────────────

/**
 * Advances one player by dt seconds.
 * @param {object} player
 * @param {{grid: Uint8Array, movers: Array}} map
 * @param {object} gimmick   theme.gimmick (friction, gravityScale, ...)
 * @param {number} dt        seconds (clamped by caller)
 * @param {number} now       ms timestamp
 * @param {number} [lavaY]   current lava height (vulcão), px — below = death
 * @param {number} [windVx]  current wind velocity (deserto), px/s
 */
export function step(player, map, gimmick = {}, dt, now, lavaY = Infinity, windVx = 0) {
  const p = player

  // Dead: wait for respawn
  if (p.deadUntil > now) return
  if (p.deadUntil !== 0 && p.deadUntil <= now) {
    p.deadUntil = 0
    p.x = p.spawn.x
    p.y = p.spawn.y
    p.vx = 0
    p.vy = 0
  }

  const gravity = GRAV * (gimmick.gravityScale ?? 1)
  // Slide ONLY on SLIP tiles (ice/sand blocks) — normal friction elsewhere.
  const friction = onSlipGround(p, map) ? SLIP_FRICTION : FRICTION
  const dashing = p.dashUntil > now

  // ── Input → intent ──
  const dir = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0)
  if (dir !== 0) p.facing = dir

  if (p.input.jumpEdge) p.jumpBufferedAt = now
  p.input.jumpEdge = false

  // Dash trigger
  if (p.input.dashEdge && now >= p.dashCdUntil && !dashing) {
    p.dashUntil = now + DASH_MS
    p.dashCdUntil = now + DASH_CD_MS
    p.dashDir = dir !== 0 ? dir : p.facing
    p.vy = 0
  }
  p.input.dashEdge = false

  // ── Horizontal velocity ──
  if (dashing || p.dashUntil > now) {
    p.vx = DASH_V * p.dashDir
  } else if (dir !== 0) {
    const accel = p.onGround ? ACCEL : AIR_ACCEL
    p.vx += dir * accel * dt
    const cap = MOVE_SPEED
    if (p.vx > cap) p.vx = cap
    if (p.vx < -cap) p.vx = -cap
  } else if (p.onGround) {
    if (friction === SLIP_FRICTION) {
      // SLIP tiles (gelo/areia): keep the slide — that's their gimmick
      p.vx *= Math.pow(1 - friction, dt * 60)
      if (Math.abs(p.vx) < 4) p.vx = 0
    } else {
      // normal ground: released the d-pad → stop dead, no skid
      p.vx = 0
    }
  }

  // Conveyor (tech): belts push while grounded; direction alternates per row
  if (gimmick.conveyor && p.onGround) {
    const rowDir = (Math.floor(p.y / TILE) % 2 === 0) ? 1 : -1
    p.vx += gimmick.conveyor * dt * 3 * rowDir
  }

  // Wind (deserto)
  if (windVx) p.vx += windVx * dt * 2

  // ── Vertical velocity ──
  if (!(p.dashUntil > now)) {
    p.vy += gravity * dt
    if (p.vy > MAX_FALL) p.vy = MAX_FALL
  }

  // Wall slide: falling + pressing into an adjacent wall
  p.wallDir = wallContact(p, map)
  const pressingWall = (p.wallDir === -1 && p.input.left) || (p.wallDir === 1 && p.input.right)
  if (!p.onGround && p.vy > 0 && pressingWall) {
    if (p.vy > WALL_SLIDE) p.vy = WALL_SLIDE
  }

  // ── Jump (ground w/ coyote, or wall-jump) ──
  const buffered = now - p.jumpBufferedAt <= JUMP_BUFFER_MS
  const canCoyote = now - p.lastGroundAt <= COYOTE_MS
  if (buffered) {
    if (p.onGround || canCoyote) {
      p.vy = -JUMP_V
      p.onGround = false
      p.jumpBufferedAt = -1e9
      p.lastGroundAt = -1e9
    } else if (p.wallDir !== 0 && pressingWall) {
      p.vy = -WALL_JUMP_VY
      p.vx = -p.wallDir * WALL_JUMP_VX
      p.facing = -p.wallDir
      p.jumpBufferedAt = -1e9
    }
  }

  // Variable jump height: releasing jump early cuts ascent
  if (!p.input.jump && p.vy < -200) p.vy = -200

  // ── Integrate + collide (axis by axis) ──
  moveAxis(p, map, p.vx * dt, 0, now)
  moveAxis(p, map, 0, p.vy * dt, now, gimmick)

  // Moving platforms: land on top, inherit delta
  rideMovers(p, map, now, gimmick)

  // ── Hazards & world kill ──
  if (touchesHazard(p, map, gimmick) || p.y - p.h / 2 > H * TILE || p.y + p.h / 2 > lavaY) {
    kill(p, now)
    return
  }

  if (p.onGround) p.lastGroundAt = now
}

// ── Gimmick helper: lava height for the vulcão theme ─────────────────────────
/** Returns current lava Y (px) given round elapsed ms. Infinity = no lava. */
export function lavaHeight(gimmick, roundElapsedMs) {
  if (!gimmick.lavaRiseSpeed) return Infinity
  // Starts 2 tiles BELOW the map bottom — players get ~12s at 8px/s before
  // it even reaches the floor, instead of dying at the spawn.
  const start = (H + 2) * TILE
  return start - (roundElapsedMs / 1000) * gimmick.lavaRiseSpeed
}

/** Returns current wind vx (px/s) for the deserto theme. */
export function windAt(gimmick, nowMs) {
  if (!gimmick.wind) return 0
  const { strength, periodMs } = gimmick.wind
  const phase = Math.floor(nowMs / periodMs) % 2 === 0 ? 1 : -1
  // gusts: on for the first 40% of each period
  const inGust = (nowMs % periodMs) < periodMs * 0.4
  return inGust ? strength * phase : 0
}

// ── Collision internals ──────────────────────────────────────────────────────

const tileAt = (grid, cx, cy) =>
  (cx < 0 || cx >= W || cy < 0 || cy >= H) ? T.BLOCK : grid[cy * W + cx]

const isSolidTile = (t) => t === T.BLOCK || t === T.SLIP

/** Is the tile right under the player's feet a SLIP block? */
function onSlipGround(p, map) {
  if (!p.onGround) return false
  const cy = Math.floor((p.y + p.h / 2 + 4) / TILE)
  const cxL = Math.floor((p.x - p.w / 2 + 2) / TILE)
  const cxR = Math.floor((p.x + p.w / 2 - 2) / TILE)
  return tileAt(map.grid, cxL, cy) === T.SLIP || tileAt(map.grid, cxR, cy) === T.SLIP
}

function solidAt(p, map, x, y, movingDown, gimmick) {
  const t = tileAt(map.grid, Math.floor(x / TILE), Math.floor(y / TILE))
  if (isSolidTile(t)) return 'solid'
  if (t === T.ONEWAY && movingDown && !p.input.down) {
    // only solid when feet were above the platform top this frame
    const platTop = Math.floor(y / TILE) * TILE
    if (p.y + p.h / 2 - p.vy * (1 / 60) <= platTop + 6) return 'oneway'
  }
  return null
}

function moveAxis(p, map, dx, dy, now, gimmick = {}) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (TILE / 2)))
  const sx = dx / steps
  const sy = dy / steps

  for (let i = 0; i < steps; i++) {
    if (sx !== 0) {
      const nx = p.x + sx
      const edgeX = nx + Math.sign(sx) * (p.w / 2)
      const top = p.y - p.h / 2 + 2
      const bottom = p.y + p.h / 2 - 2
      let hit = false
      for (let y = top; y <= bottom + 0.01; y += Math.min(TILE, bottom - top)) {
        if (solidAt(p, map, edgeX, y, false, gimmick) === 'solid') { hit = true; break }
      }
      if (hit) {
        p.x = Math.sign(sx) > 0
          ? Math.floor(edgeX / TILE) * TILE - p.w / 2 - 0.01
          : (Math.floor(edgeX / TILE) + 1) * TILE + p.w / 2 + 0.01
        p.vx = 0
        if (p.dashUntil > now) p.dashUntil = 0
      } else {
        p.x = nx
      }
    }

    if (sy !== 0) {
      const ny = p.y + sy
      const movingDown = sy > 0
      const edgeY = ny + Math.sign(sy) * (p.h / 2)
      const left = p.x - p.w / 2 + 2
      const right = p.x + p.w / 2 - 2
      let hit = null
      for (let x = left; x <= right + 0.01; x += Math.min(TILE, right - left)) {
        const s = solidAt(p, map, x, edgeY, movingDown, gimmick)
        if (s) { hit = s; break }
      }
      if (hit) {
        if (movingDown) {
          p.y = Math.floor(edgeY / TILE) * TILE - p.h / 2 - 0.01
          p.vy = 0
          p.onGround = true
          // bounce pads (floresta): oneway = trampolim
          if (hit === 'oneway' && gimmick.bouncePads) {
            p.vy = -JUMP_V * 1.45
            p.onGround = false
          }
        } else {
          p.y = (Math.floor(edgeY / TILE) + 1) * TILE + p.h / 2 + 0.01
          p.vy = 0
        }
      } else {
        p.y = ny
        if (movingDown) p.onGround = false
      }
    }
  }
}

function wallContact(p, map) {
  const top = p.y - p.h / 2 + 4
  const bottom = p.y + p.h / 2 - 4
  const leftX = p.x - p.w / 2 - 2
  const rightX = p.x + p.w / 2 + 2
  for (let y = top; y <= bottom; y += (bottom - top) / 2) {
    if (isSolidTile(tileAt(map.grid, Math.floor(leftX / TILE), Math.floor(y / TILE)))) return -1
  }
  for (let y = top; y <= bottom; y += (bottom - top) / 2) {
    if (isSolidTile(tileAt(map.grid, Math.floor(rightX / TILE), Math.floor(y / TILE)))) return 1
  }
  return 0
}

function touchesHazard(p, map, gimmick = {}) {
  const pts = [
    [p.x, p.y + p.h / 2 - 2],
    [p.x - p.w / 2 + 2, p.y],
    [p.x + p.w / 2 - 2, p.y],
    [p.x, p.y - p.h / 2 + 2],
  ]
  for (const [x, y] of pts) {
    if (tileAt(map.grid, Math.floor(x / TILE), Math.floor(y / TILE)) === T.HAZARD) {
      // quicksand (deserto): shallow hazard sinks instead of killing
      if (gimmick.quicksand) {
        p.vy = Math.min(p.vy, 20)
        p.y += 20 * (1 / 60)
        // only dies fully submerged (head below hazard top)
        const headTile = tileAt(map.grid, Math.floor(p.x / TILE), Math.floor((p.y - p.h / 2) / TILE))
        return headTile === T.HAZARD
      }
      return true
    }
  }
  return false
}

/** Position of a mover at time now (px, top-left of its platform). */
export function moverPos(m, now, gimmick = {}) {
  const speedScale = gimmick.moverSpeedScale ?? 1
  const period = m.period / speedScale
  const t = (now % (period * 2)) / period      // 0..2
  const k = t < 1 ? t : 2 - t                  // ping-pong 0..1..0
  return {
    x: m.x + (m.x2 - m.x) * k,
    y: m.y + (m.y2 - m.y) * k,
    w: TILE * 2,
    h: 10,
  }
}

function rideMovers(p, map, now, gimmick) {
  if (p.vy < 0) return
  for (const m of map.movers) {
    const pos = moverPos(m, now, gimmick)
    const prevPos = moverPos(m, now - 16, gimmick)
    const feet = p.y + p.h / 2
    if (
      p.x + p.w / 2 > pos.x && p.x - p.w / 2 < pos.x + pos.w &&
      feet >= pos.y - 6 && feet <= pos.y + pos.h + 6
    ) {
      p.y = pos.y - p.h / 2 - 0.01
      p.vy = 0
      p.onGround = true
      p.lastGroundAt = now
      p.x += pos.x - prevPos.x // inherit platform motion
    }
  }
}
