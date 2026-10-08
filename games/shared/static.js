// games/shared/static.js
// Static file serving for the games' local bridges (games/*/server.js) —
// the page a physical cabinet's browser loads. Not a game itself (no
// public/index.html), so the backend's /embed never lists it.
//
//   - Only files INSIDE the game's public/ are served (the old
//     path.join(public, req.url) let `GET /../.env` read the bridge's .env,
//     TOTEM_KEY included).
//   - /assets/fonts/* and /assets/brand/* fall back to the backend repo's
//     public/assets, so the brand typeface (Araboto) and marks load on the
//     cabinet exactly as they do in the embedded iframe.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public')
const SHARED_PREFIXES = ['/assets/fonts/', '/assets/brand/']

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
}

/** Absolute file for `urlPath` inside `root`, or null when it escapes / is invalid. */
export function resolveInside(root, urlPath) {
  let rel
  try { rel = decodeURIComponent(urlPath) } catch { return null }
  if (rel.includes('\0')) return null
  const base = path.resolve(root)
  const abs = path.resolve(base, '.' + path.sep + rel.replace(/^[/\\]+/, ''))
  return abs === base || abs.startsWith(base + path.sep) ? abs : null
}

function send(res, file) {
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500)
      res.end(err.code === 'ENOENT' || err.code === 'EISDIR' ? 'Not found' : 'Server error')
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
    res.end(content)
  })
}

/** Serves GET requests for the game's public/ (+ shared brand assets). */
export function serveStatic(req, res, publicDir) {
  const urlPath = (req.url ?? '/').split('?')[0]
  const wanted = urlPath === '/' ? '/index.html' : urlPath

  const own = resolveInside(publicDir, wanted)
  if (!own) { res.writeHead(404); res.end('Not found'); return }

  if (SHARED_PREFIXES.some(p => wanted.startsWith(p)) && !fs.existsSync(own)) {
    const shared = resolveInside(REPO_PUBLIC, wanted)
    if (shared) return send(res, shared)
  }
  send(res, own)
}
