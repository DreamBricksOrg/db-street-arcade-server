// src/lib/games.js
// Browser games that can be embedded: every folder in GAMES_DIR that ships a
// public/index.html (games/snake, games/brick-rush, ...).

import fs   from 'node:fs'
import path from 'node:path'

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function gamePublicDir(gamesDir, name) {
  return path.join(gamesDir, name, 'public')
}

export function isKnownGame(gamesDir, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return false
  return fs.existsSync(path.join(gamePublicDir(gamesDir, name), 'index.html'))
}

export function listGames(gamesDir) {
  try {
    return fs.readdirSync(gamesDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && isKnownGame(gamesDir, d.name))
      .map(d => d.name)
      .sort()
  } catch {
    return []
  }
}
