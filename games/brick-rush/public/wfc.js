// games/brick-rush/public/wfc.js
// Wave Function Collapse map generator + reachability validation.
//
// generateMap(theme, playerCount):
//   1. collapse(theme)  — WFC over a 40×22 grid with the theme's tile weights
//                          and adjacency rules (forced solid borders)
//   2. post-processing  — carve spawns on the bottom, place the brick on the
//                          highest standable platform, extract movers from RAILs
//   3. reachable()      — BFS using the players' real movement envelope
//                          (jump dx≤4/dy≤3, wall-climb, movers as bridges)
//   Up to 20 attempts; if none is winnable → theme's handcrafted fallback.
//   The arcade NEVER receives an impossible map.
//
// Pure logic — no DOM. Also runs under Node for the test harness.

import { T, W, H, TILE, parseFallback } from './maps.js'

const TILES = [T.EMPTY, T.BLOCK, T.ONEWAY, T.HAZARD, T.RAIL, T.SLIP]
const MAX_ATTEMPTS = 20

/** Tiles the player collides with / can stand on / wall-jump from. */
const isSolid = (t) => t === T.BLOCK || t === T.SLIP

// Movement envelope used by the validator. MUST stay ≤ what physics.js can
// actually do (physics.test.mjs asserts the real envelope covers this).
const JUMP_DX = 4   // horizontal tiles reachable in one jump
const JUMP_DY = 3   // vertical tiles gained in one jump / wall-jump

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {object} theme        entry from maps.js THEMES
 * @param {number} playerCount  how many spawn points to carve
 * @returns {{ theme, grid, movers, spawns, brick, brickCell, fallback }}
 */
export function generateMap(theme, playerCount) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const grid = collapse(theme)
    if (!grid) continue

    const map = postProcess(theme, grid, playerCount)
    if (!map) continue

    // Generate & repair: if a spawn can't reach the brick, build stepping
    // platforms from the reachable frontier toward the brick (keeps the WFC
    // shape, guarantees a path) and revalidate.
    repairPaths(map)

    if (map.spawns.every(s => reachable(map, s))) {
      map.fallback = false
      return map
    }
  }

  // Guaranteed-playable handcrafted map
  const grid = parseFallback(theme.fallbackRows)
  const map = postProcess(theme, grid, playerCount, /*carveIfNeeded*/ true)
  map.fallback = true
  return map
}

/**
 * Safe respawn point when the lava is rising (vulcão): the LOWEST supported
 * cell that is comfortably above the lava line, closest to nearX. Falls back
 * to the brick platform (always the highest supported cell) if nothing else.
 * @param {{grid, movers, brickCell}} map
 * @param {number} lavaY   px
 * @param {number} nearX   px — prefer spawning near where the player died
 * @returns {{x, y}} px center of the safe cell
 */
export function findSafeSpawn(map, lavaY, nearX) {
  const { grid } = map
  const at = (x, y) => grid[y * W + x]
  const safeLimit = lavaY - 3 * TILE
  let best = null
  let bestScore = -Infinity

  for (let y = 1; y < H - 1; y++) {
    const cellBottom = (y + 1) * TILE
    if (cellBottom > safeLimit) continue
    for (let x = 2; x < W - 2; x++) {
      const below = at(x, y + 1)
      if (at(x, y) !== T.EMPTY || !(isSolid(below) || below === T.ONEWAY)) continue
      // prefer LOW cells (more room to climb) and close to nearX
      const score = y * 10 - Math.abs(x * TILE - nearX) / TILE
      if (score > bestScore) {
        bestScore = score
        best = { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 }
      }
    }
  }

  if (best) return best
  return { x: map.brickCell.cx * TILE + TILE / 2, y: map.brickCell.cy * TILE + TILE / 2 }
}

/**
 * BFS from a spawn to the brick using the movement envelope.
 * Nodes: standable cells (support below OR wall-cling) + mover spans.
 * @param {{grid, movers, brickCell}} map
 * @param {{x, y}} spawn  (px)
 * @returns {boolean}
 */
export function reachable(map, spawn) {
  const { grid, movers, brickCell } = map
  const startCell = { cx: Math.floor(spawn.x / TILE), cy: Math.floor(spawn.y / TILE) }
  if (!brickCell) return false

  const standable = computeStandable(grid, movers)
  const key = (cx, cy) => cy * W + cx

  if (!standable.has(key(startCell.cx, startCell.cy))) {
    // spawn must itself be standable; carving guarantees this, but be strict
    return false
  }

  const target = key(brickCell.cx, brickCell.cy)
  const visited = new Set([key(startCell.cx, startCell.cy)])
  const queue = [startCell]

  while (queue.length > 0) {
    const { cx, cy } = queue.shift()
    if (key(cx, cy) === target) return true

    for (const nk of neighborsOf(cx, cy, grid, standable)) {
      if (!visited.has(nk)) {
        visited.add(nk)
        queue.push({ cx: nk % W, cy: Math.floor(nk / W) })
      }
    }
  }
  return false
}

// Test-only handles (wfc.debug.mjs)
export const _debug = {
  collapse: (theme) => collapse(theme),
  postProcess: (theme, grid, n) => postProcess(theme, grid, n),
  repairPaths: (map) => repairPaths(map),
}

// ── WFC core ─────────────────────────────────────────────────────────────────

/** One collapse attempt. Returns Uint8Array grid or null on contradiction. */
function collapse(theme) {
  // Domain per cell as a bitmask over TILES indices.
  const FULL = (1 << TILES.length) - 1
  const domains = new Uint8Array(W * H).fill(FULL)

  const bit = (tile) => 1 << TILES.indexOf(tile)
  const only = (tile) => bit(tile)

  // Forced borders: solid frame.
  for (let x = 0; x < W; x++) {
    domains[0 * W + x] = only(T.BLOCK)
    domains[(H - 1) * W + x] = only(T.BLOCK)
  }
  for (let y = 0; y < H; y++) {
    domains[y * W + 0] = only(T.BLOCK)
    domains[y * W + (W - 1)] = only(T.BLOCK)
  }
  // Top play rows biased open (brick zone) and bottom play row biased open
  // (spawn zone): no hazards/rails there.
  for (let x = 1; x < W - 1; x++) {
    domains[1 * W + x] &= (bit(T.EMPTY) | bit(T.BLOCK) | bit(T.ONEWAY))
    domains[2 * W + x] &= (bit(T.EMPTY) | bit(T.BLOCK) | bit(T.ONEWAY))
    domains[(H - 2) * W + x] &= (bit(T.EMPTY) | bit(T.BLOCK))
  }

  const popcount = (m) => { let c = 0; while (m) { m &= m - 1; c++ } return c }

  // Propagate constraints from a cell to its neighbors (arc consistency).
  function propagate(startIdx) {
    const stack = [startIdx]
    while (stack.length > 0) {
      const idx = stack.pop()
      const cx = idx % W, cy = Math.floor(idx / W)
      const dirs = [[1, 0, 0], [0, 1, 1], [-1, 0, 2], [0, -1, 3]] // dx, dy, dir

      for (const [dx, dy, dir] of dirs) {
        const nx = cx + dx, ny = cy + dy
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue
        const nIdx = ny * W + nx

        // Filter neighbor domain: keep tile b only if SOME tile a in this
        // cell's domain allows b in direction dir.
        let newDomain = 0
        for (let bi = 0; bi < TILES.length; bi++) {
          if (!(domains[nIdx] & (1 << bi))) continue
          let supported = false
          for (let ai = 0; ai < TILES.length; ai++) {
            if (!(domains[idx] & (1 << ai))) continue
            if (theme.rules(TILES[ai], TILES[bi], dir)) { supported = true; break }
          }
          if (supported) newDomain |= (1 << bi)
        }

        if (newDomain === 0) {
          _debug.lastContradiction = { cx, cy, nx, ny, dir, sourceDomain: domains[idx] }
          return false // contradiction
        }
        if (newDomain !== domains[nIdx]) {
          domains[nIdx] = newDomain
          stack.push(nIdx)
        }
      }
    }
    return true
  }

  // Seed propagation from the forced cells.
  for (let x = 0; x < W; x++) {
    if (!propagate(0 * W + x) || !propagate((H - 1) * W + x)) return null
  }
  for (let y = 0; y < H; y++) {
    if (!propagate(y * W + 0) || !propagate(y * W + (W - 1))) return null
  }

  // Collapse loop: lowest-entropy cell → weighted pick → propagate.
  while (true) {
    let bestIdx = -1
    let bestCount = Infinity
    for (let i = 0; i < domains.length; i++) {
      const c = popcount(domains[i])
      if (c > 1 && c < bestCount) { bestCount = c; bestIdx = i }
    }
    if (bestIdx === -1) break // fully collapsed

    // Weighted random pick among remaining options. Weight 0 (or absent)
    // means "this theme never generates this tile" — only used if it's the
    // sole remaining option (forced by constraints).
    const options = []
    let totalWeight = 0
    for (let ti = 0; ti < TILES.length; ti++) {
      if (domains[bestIdx] & (1 << ti)) {
        const w = theme.weights[TILES[ti]] ?? 0
        options.push([ti, w])
        totalWeight += w
      }
    }
    let chosen
    if (totalWeight <= 0) {
      chosen = options[0][0]
    } else {
      let r = Math.random() * totalWeight
      chosen = options[options.length - 1][0]
      for (const [ti, w] of options) {
        r -= w
        if (r <= 0 && w > 0) { chosen = ti; break }
      }
    }

    domains[bestIdx] = 1 << chosen
    if (!propagate(bestIdx)) return null
  }

  const grid = new Uint8Array(W * H)
  for (let i = 0; i < domains.length; i++) {
    grid[i] = TILES[Math.log2(domains[i]) | 0]
  }
  return grid
}

// ── Post-processing ──────────────────────────────────────────────────────────

function postProcess(theme, grid, playerCount, carveIfNeeded = true) {
  const at = (x, y) => grid[y * W + x]
  const set = (x, y, t) => { grid[y * W + x] = t }

  // 1. Carve spawn pockets along the bottom row, evenly spread.
  const spawns = []
  const spacing = Math.floor((W - 8) / Math.max(1, playerCount))
  for (let i = 0; i < playerCount; i++) {
    const sx = 4 + i * spacing + Math.floor(spacing / 2)
    // pocket: EMPTY at feet + head, solid BLOCK floor
    set(sx, H - 2, T.EMPTY)
    set(sx, H - 3, T.EMPTY)
    if (at(sx, H - 1) !== T.BLOCK) set(sx, H - 1, T.BLOCK)
    // no hazard right beside a spawn
    for (const dx of [-1, 1]) {
      if (at(sx + dx, H - 2) === T.HAZARD) set(sx + dx, H - 2, T.EMPTY)
    }
    spawns.push({ x: sx * TILE + TILE / 2, y: (H - 2) * TILE + TILE / 2 })
  }

  // 2. Extract movers from horizontal RAIL runs (length ≥ 2).
  const movers = []
  for (let y = 1; y < H - 1; y++) {
    let runStart = -1
    for (let x = 1; x < W; x++) {
      const isRail = x < W - 1 && at(x, y) === T.RAIL
      if (isRail && runStart === -1) runStart = x
      if (!isRail && runStart !== -1) {
        const runEnd = x - 1
        if (runEnd - runStart >= 1) {
          movers.push({
            x: runStart * TILE, y: y * TILE,
            x2: runEnd * TILE, y2: y * TILE,
            period: 3000,
          })
        }
        // rails become empty space (the platform travels through them)
        for (let rx = runStart; rx <= runEnd; rx++) set(rx, y, T.EMPTY)
        runStart = -1
      }
    }
  }
  // stray single rails → empty
  for (let i = 0; i < grid.length; i++) if (grid[i] === T.RAIL) grid[i] = T.EMPTY

  // 3. Brick: highest SUPPORTED cell (real platform below — wall-cling spots
  // don't count, otherwise the brick ends up glued to the border walls),
  // far from the spawn center. Skip cells hugging the side borders.
  const spawnMeanX = spawns.reduce((a, s) => a + s.x, 0) / spawns.length / TILE
  let brickCell = null
  outer:
  for (let y = 1; y < Math.floor(H / 2); y++) {
    const rowCells = []
    for (let x = 3; x < W - 3; x++) {
      const here = at(x, y)
      const below = at(x, y + 1)
      if (here === T.EMPTY && (isSolid(below) || below === T.ONEWAY)) rowCells.push(x)
    }
    if (rowCells.length > 0) {
      rowCells.sort((a, b) => Math.abs(b - spawnMeanX) - Math.abs(a - spawnMeanX))
      brickCell = { cx: rowCells[0], cy: y }
      break outer
    }
  }

  if (!brickCell) {
    if (!carveIfNeeded) return null
    // Carve a platform near the top center as a last resort.
    const bx = Math.floor(W / 2)
    set(bx, 3, T.EMPTY); set(bx, 4, T.BLOCK)
    set(bx - 1, 3, T.EMPTY); set(bx + 1, 3, T.EMPTY)
    brickCell = { cx: bx, cy: 3 }
  }

  return {
    theme,
    grid,
    movers,
    spawns,
    brickCell,
    brick: { x: brickCell.cx * TILE + TILE / 2, y: brickCell.cy * TILE + TILE / 2 },
    fallback: false,
  }
}

// ── Generate & repair ────────────────────────────────────────────────────────

/**
 * For every spawn that can't reach the brick, grows stepping platforms from
 * the closest reachable cell toward the brick until a path exists (or the
 * repair budget runs out — the attempt is then discarded by the caller).
 */
function repairPaths(map) {
  const { grid, movers, brickCell } = map
  const at = (x, y) => grid[y * W + x]
  const set = (x, y, t) => { grid[y * W + x] = t }
  const key = (cx, cy) => cy * W + cx

  for (const spawn of map.spawns) {
    let budget = 40
    while (budget-- > 0 && !reachable(map, spawn)) {
      // Reachable set from this spawn (re-run the same BFS, collecting cells)
      const standable = computeStandable(grid, movers)
      const start = { cx: Math.floor(spawn.x / TILE), cy: Math.floor(spawn.y / TILE) }
      if (!standable.has(key(start.cx, start.cy))) break

      const visited = new Set([key(start.cx, start.cy)])
      const queue = [start]
      while (queue.length > 0) {
        const { cx, cy } = queue.shift()
        for (const nk of neighborsOf(cx, cy, grid, standable)) {
          if (!visited.has(nk)) {
            visited.add(nk)
            queue.push({ cx: nk % W, cy: Math.floor(nk / W) })
          }
        }
      }

      // Frontier cell closest to the brick
      let best = null
      let bestDist = Infinity
      for (const k of visited) {
        const cx = k % W, cy = Math.floor(k / W)
        const d = Math.abs(cx - brickCell.cx) + Math.abs(cy - brickCell.cy)
        if (d < bestDist) { bestDist = d; best = { cx, cy } }
      }
      if (!best) break

      // One step toward the brick, within the jump envelope (dx≤3, dy=-2 when
      // climbing). Carve a small standable ledge there.
      const dxTotal = brickCell.cx - best.cx
      const dyTotal = brickCell.cy - best.cy
      const stepX = Math.max(-3, Math.min(3, dxTotal))
      const stepY = dyTotal < 0 ? -2 : (dyTotal > 0 ? 2 : 0)
      const nx = Math.max(2, Math.min(W - 3, best.cx + stepX))
      const ny = Math.max(2, Math.min(H - 3, best.cy + stepY))

      set(nx, ny, T.EMPTY)          // feet
      set(nx, ny - 1, T.EMPTY)      // headroom
      set(nx, ny + 1, T.BLOCK)      // support
      if (at(nx - 1, ny + 1) === T.EMPTY && nx - 1 >= 1) set(nx - 1, ny + 1, T.BLOCK)
      if (at(nx - 1, ny) !== T.BLOCK) set(nx - 1, ny, T.EMPTY)
    }
  }
}

// ── Reachability helpers ─────────────────────────────────────────────────────

/**
 * Standable cells: EMPTY/HAZARD-free cells you can hold position at —
 * support below (BLOCK/ONEWAY), wall-cling (BLOCK beside), or a mover
 * passing underneath.
 */
function computeStandable(grid, movers) {
  const at = (x, y) => grid[y * W + x]
  const standable = new Set()

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (at(x, y) !== T.EMPTY) continue
      const below = at(x, y + 1)
      const support = isSolid(below) || below === T.ONEWAY
      const wall = isSolid(at(x - 1, y)) || isSolid(at(x + 1, y))
      if (support || wall) standable.add(y * W + x)
    }
  }

  // Mover spans: every cell one tile above the mover's travel line.
  for (const m of movers) {
    const y = Math.floor(m.y / TILE) - 1
    if (y < 1) continue
    const fromX = Math.floor(Math.min(m.x, m.x2) / TILE)
    const toX = Math.floor(Math.max(m.x, m.x2) / TILE)
    for (let x = fromX; x <= toX; x++) {
      if (x >= 1 && x < W - 1 && grid[y * W + x] === T.EMPTY) standable.add(y * W + x)
    }
  }

  return standable
}

/**
 * Envelope expansion from one standable cell to others.
 * STRICT corridor validation: the jump arc (rise in the source column →
 * traverse at the apex row → descend in the target column) must cross only
 * non-solid cells. This is what prevents the validator from approving maps
 * where the brick sits inside a sealed pocket — a jump can never pass
 * through a wall, however thin.
 */
function neighborsOf(cx, cy, grid, standable) {
  const passable = (x, y) => {
    if (x < 1 || x > W - 2 || y < 1 || y > H - 2) return false
    return !isSolid(grid[y * W + x]) // ONEWAY/HAZARD/EMPTY are passable in-flight
  }
  const out = []

  for (let ny = Math.max(1, cy - JUMP_DY); ny <= H - 2; ny++) { // rising ≤ JUMP_DY, falling unlimited
    for (let nx = Math.max(1, cx - JUMP_DX); nx <= Math.min(W - 2, cx + JUMP_DX); nx++) {
      if (nx === cx && ny === cy) continue
      const nk = ny * W + nx
      if (!standable.has(nk)) continue
      if (!corridorClear(cx, cy, nx, ny, passable)) continue
      out.push(nk)
    }
  }
  return out
}

/** L-shaped flight path: up to the apex, across, then down to the target. */
function corridorClear(cx, cy, nx, ny, passable) {
  const apexY = Math.max(1, Math.min(cy, ny) - 1)
  // rise in the source column (cell above the head must be free the whole way)
  for (let y = cy - 1; y >= apexY; y--) {
    if (!passable(cx, y)) return false
  }
  // traverse at the apex row
  const stepX = nx >= cx ? 1 : -1
  for (let x = cx + stepX; x !== nx + stepX; x += stepX) {
    if (!passable(x, apexY)) return false
  }
  // descend in the target column (includes the target cell itself)
  for (let y = apexY + 1; y <= ny; y++) {
    if (!passable(nx, y)) return false
  }
  return true
}
