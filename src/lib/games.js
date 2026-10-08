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

/**
 * Form description of a game's settings (games/<game>/config.schema.json):
 * { title, fields: [{ key, label, type: 'number'|'boolean', unit?, scale?,
 *   min?, max?, step?, default, help? }] }. `scale` converts the shown value
 * to the stored one (seconds shown, milliseconds stored). null if absent.
 */
export function gameConfigSchema(gamesDir, name) {
  if (!isKnownGame(gamesDir, name)) return null
  try {
    const schema = JSON.parse(fs.readFileSync(path.join(gamesDir, name, 'config.schema.json'), 'utf8'))
    return Array.isArray(schema?.fields) ? schema : null
  } catch {
    return null
  }
}

/**
 * Checks the fields a schema knows (stored units); other keys pass through
 * untouched (advanced JSON). @returns {string|null} pt-BR error
 */
export function validateGameConfig(schema, config) {
  if (!schema || !config) return null
  for (const f of schema.fields) {
    if (!(f.key in config)) continue
    const v = config[f.key]
    if (f.type === 'boolean') {
      if (typeof v !== 'boolean') return `${f.label}: use ligado ou desligado.`
      continue
    }
    const scale = f.scale ?? 1
    if (typeof v !== 'number' || !Number.isFinite(v)) return `${f.label}: precisa ser um número.`
    const shown = v / scale
    if (f.min !== undefined && shown < f.min) return `${f.label}: mínimo ${f.min}${f.unit ? ` ${f.unit}` : ''}.`
    if (f.max !== undefined && shown > f.max) return `${f.label}: máximo ${f.max}${f.unit ? ` ${f.unit}` : ''}.`
  }
  return null
}
