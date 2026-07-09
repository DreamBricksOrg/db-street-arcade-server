// games/brick-rush/test/wfc.test.mjs
// Guarantees every map handed to a round is winnable: 200 generations per
// theme, every spawn must reach the brick (WFC output or handcrafted fallback).
// Run: node games/brick-rush/test/wfc.test.mjs

import assert from 'node:assert/strict'
import { generateMap, reachable } from '../public/wfc.js'
import { THEMES, W, H } from '../public/maps.js'

const RUNS = 200
let fallbacks = 0

for (const theme of THEMES) {
  for (let i = 0; i < RUNS; i++) {
    const map = generateMap(theme, 3)

    assert.equal(map.grid.length, W * H, `${theme.id}: grid size`)
    assert.equal(map.spawns.length, 3, `${theme.id}: 3 spawns`)
    assert.ok(map.brick && map.brick.x >= 0, `${theme.id}: brick placed`)
    if (map.fallback) fallbacks++

    for (const s of map.spawns) {
      assert.ok(
        reachable(map, s),
        `${theme.id} run ${i}${map.fallback ? ' (FALLBACK!)' : ''}: spawn (${s.x},${s.y}) não alcança o brick`,
      )
    }
  }
  console.log(`OK  ${theme.id}`)
}

console.log(`fallbacks acionados: ${fallbacks}/${THEMES.length * RUNS}`)
console.log('ALL MAP GENERATION TESTS PASSED')
