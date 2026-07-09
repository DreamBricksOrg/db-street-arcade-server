// games/brick-rush/public/maps.js
// The 6 themed tilesets for Brick Rush: WFC weights + adjacency rules +
// physics gimmick + a handcrafted fallback map guaranteed to be playable.
// Pure data/logic — no DOM. Also imported by the Node test harness.

// ── Grid contract ─────────────────────────────────────────────────────────────
// SLIP = bloco sólido escorregadio (gelo/areia) — o deslize acontece SÓ em
// cima dele, não no mapa inteiro. HAZARD existe no contrato mas nenhum tema
// gera mais tiles letais: a única morte ambiental é a lava subindo (vulcão).
export const T = { EMPTY: 0, BLOCK: 1, ONEWAY: 2, HAZARD: 3, RAIL: 4, SLIP: 5 }
export const W = 40
export const H = 22
export const TILE = 32

// Fallback grids: 22 rows × 40 chars. ' '=EMPTY '#'=BLOCK '-'=ONEWAY '~'=HAZARD '='=RAIL '*'=SLIP
const CHAR_TO_TILE = { ' ': T.EMPTY, '#': T.BLOCK, '-': T.ONEWAY, '~': T.HAZARD, '=': T.RAIL, '*': T.SLIP }

export function parseFallback(rows) {
  const grid = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      grid[y * W + x] = CHAR_TO_TILE[rows[y]?.[x] ?? ' '] ?? T.EMPTY
    }
  }
  // Enforce solid borders regardless of hand-drawn row lengths.
  for (let x = 0; x < W; x++) {
    grid[0 * W + x] = T.BLOCK
    grid[(H - 1) * W + x] = T.BLOCK
  }
  for (let y = 0; y < H; y++) {
    grid[y * W + 0] = T.BLOCK
    grid[y * W + (W - 1)] = T.BLOCK
  }
  return grid
}

// A single handcrafted layout skeleton reused by every theme's fallback —
// staircase of platforms + wall-jump chimneys, verified reachable by the
// BFS in wfc.test.mjs. Themes reskin it visually; hazards stay in the pit.
const FALLBACK_ROWS = [
  '########################################',
  '#                                      #',
  '#                  ##                  #',
  '#      ------      ##      ------      #',
  '#                  ##                  #',
  '#  ##                              ##  #',
  '#  ##    ----    --------    ----  ##  #',
  '#  ##                              ##  #',
  '#        ##      ========      ##      #',
  '#  ----  ##                    ##  ----#',
  '#        ##  ----        ----  ##      #',
  '#        ##                    ##      #',
  '#   ##      ----  ######  ----     ##  #',
  '#   ##                             ##  #',
  '#   ##  ####    ---    ---   ####  ##  #',
  '#                                      #',
  '#     ----   ----      ----   ----     #',
  '#                                      #',
  '#  ####    ####    ##    ####    #### #',
  '#                                      #',
  '#                                      #',
  '########################################',
]

// ── Adjacency rules ───────────────────────────────────────────────────────────
// rules(a, b, dir) → can tile b sit in direction dir of tile a?
// dir: 0=right, 1=down, 2=left, 3=up. Shared base rules for every theme:
//   - ONEWAY needs EMPTY above it (jumpable through) and never stacks on ONEWAY
//   - RAIL needs EMPTY on left/right (movers travel horizontally)
//   - HAZARD sits on top of BLOCK or another HAZARD (pools), never floats mid-air
// IMPORTANT: every directional constraint MUST be written from BOTH
// perspectives — rules(a,b,dir) === rules(b,a,opposite(dir)). Asymmetric
// rules let a cell collapse into a tile its already-collapsed neighbor
// forbids, producing guaranteed contradictions late in the collapse.
function baseRules(a, b, dir) {
  const solid = (t) => t === T.BLOCK || t === T.ONEWAY || t === T.RAIL || t === T.SLIP
  // vertical: dir 1 = b is BELOW a; dir 3 = b is ABOVE a
  if (dir === 3) { // b above a
    if (a === T.ONEWAY && b === T.ONEWAY) return false
    // "hazard can't have solid above" (mirror of the dir-1 clause below)
    if (a === T.HAZARD && solid(b)) return false
    // "empty can't have hazard above" == "hazard can't float over emptiness"
    if (a === T.EMPTY && b === T.HAZARD) return false
  }
  if (dir === 1) { // b below a
    if (a === T.ONEWAY && b === T.ONEWAY) return false
    // "hazard can't float over emptiness"
    if (a === T.HAZARD && b === T.EMPTY) return false
    // mirror of the dir-3 hazard clause seen from the other side:
    if (solid(a) && b === T.HAZARD) return false
  }
  if (dir === 0 || dir === 2) { // horizontal (already symmetric)
    if (a === T.RAIL && (b === T.BLOCK || b === T.ONEWAY || b === T.SLIP)) return false
    if (b === T.RAIL && (a === T.BLOCK || a === T.ONEWAY || a === T.SLIP)) return false
  }
  return true
}

// ── Themes ────────────────────────────────────────────────────────────────────
// weights: relative probability of each tile when collapsing a cell.
// gimmick: consumed by physics.js (see applyGimmicks) and match.js (lava).
export const THEMES = [
  {
    id: 'gelo', name: 'Geleira', emoji: '❄️',
    // Deslize APENAS nos blocos de gelo (SLIP) — o resto é chão normal.
    weights: { [T.EMPTY]: 64, [T.BLOCK]: 9, [T.ONEWAY]: 14, [T.HAZARD]: 0, [T.RAIL]: 2, [T.SLIP]: 11 },
    rules: baseRules,
    gimmick: {},
    palette: { bg: '#0e1a2b', block: '#5a86a8', blockTop: '#a8cde0', oneway: '#bfe3f2', hazard: '#3edbf0', slip: '#bfeaff', slipTop: '#ffffff', accent: '#9fd8ef' },
    fallbackRows: FALLBACK_ROWS,
  },
  {
    id: 'vulcao', name: 'Vulcão', emoji: '🔥',
    // Única morte ambiental do jogo: a lava que sobe do fundo.
    weights: { [T.EMPTY]: 62, [T.BLOCK]: 22, [T.ONEWAY]: 13, [T.HAZARD]: 0, [T.RAIL]: 3 },
    rules: baseRules,
    gimmick: { lavaRiseSpeed: 8 }, // px/s
    palette: { bg: '#1a0d0a', block: '#5c4038', blockTop: '#8a655a', oneway: '#7d5a4e', hazard: '#ff5a1f', accent: '#ffb03a' },
    fallbackRows: FALLBACK_ROWS,
  },
  {
    id: 'floresta', name: 'Floresta', emoji: '🌲',
    weights: { [T.EMPTY]: 64, [T.BLOCK]: 17, [T.ONEWAY]: 17, [T.HAZARD]: 0, [T.RAIL]: 2 },
    rules: baseRules,
    gimmick: { bouncePads: true }, // ONEWAY quica: super pulo 2×
    palette: { bg: '#0d1f12', block: '#4a6b34', blockTop: '#7da653', oneway: '#c96a4a', hazard: '#7a3fa0', accent: '#a4e05f' },
    fallbackRows: FALLBACK_ROWS,
  },
  {
    id: 'tech', name: 'Laboratório', emoji: '🤖',
    weights: { [T.EMPTY]: 63, [T.BLOCK]: 18, [T.ONEWAY]: 13, [T.HAZARD]: 0, [T.RAIL]: 6 },
    rules: baseRules,
    gimmick: { conveyor: 120, moverSpeedScale: 1.5 }, // esteiras + movers rápidos
    palette: { bg: '#0a1220', block: '#3d4f66', blockTop: '#6d8fb0', oneway: '#49dfd0', hazard: '#ff3d71', accent: '#49dfd0' },
    fallbackRows: FALLBACK_ROWS,
  },
  {
    id: 'deserto', name: 'Deserto', emoji: '🏜️',
    // Dunas de areia lisa (SLIP): escorrega só nelas. Sem vento, sem areia movediça.
    weights: { [T.EMPTY]: 64, [T.BLOCK]: 10, [T.ONEWAY]: 13, [T.HAZARD]: 0, [T.RAIL]: 2, [T.SLIP]: 11 },
    rules: baseRules,
    gimmick: {},
    palette: { bg: '#211505', block: '#a8763a', blockTop: '#d0a55c', oneway: '#a8763a', hazard: '#dbb84d', slip: '#ecc575', slipTop: '#fce9b8', accent: '#f5d78a' },
    fallbackRows: FALLBACK_ROWS,
  },
  {
    id: 'cristal', name: 'Caverna de Cristal', emoji: '🔮',
    weights: { [T.EMPTY]: 68, [T.BLOCK]: 15, [T.ONEWAY]: 14, [T.HAZARD]: 0, [T.RAIL]: 3 },
    rules: baseRules,
    gimmick: { gravityScale: 0.6 },
    palette: { bg: '#150a24', block: '#5d3d8f', blockTop: '#9a6fd8', oneway: '#c79df2', hazard: '#ff4fd8', accent: '#e0c3ff' },
    fallbackRows: FALLBACK_ROWS,
  },
]

export function themeById(id) {
  return THEMES.find(t => t.id === id) ?? null
}

/** Sorteia n temas distintos (para os rounds de uma partida). */
export function pickThemes(n) {
  const pool = [...THEMES]
  const out = []
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  }
  return out
}
