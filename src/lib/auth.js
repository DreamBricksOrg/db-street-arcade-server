// src/lib/auth.js
// Operator auth primitives — pure, no I/O, clock injectable for tests.
//
// An operator logs in (their account, or the bootstrap `admin` with
// OPERATOR_PASSWORD) and gets an HMAC-signed cookie
// `sa_op=<expiresAtMs>.<subject>.<sig>`, where subject names the account
// (`<userId>:<tokenVersion>`, base64url). The signing key is derived from
// OPERATOR_PASSWORD, so every backend process accepts the same cookie (no
// shared session store) and changing that password logs everyone out.

import crypto from 'node:crypto'

export const COOKIE_NAME = 'sa_op'

/** Constant-time string compare (false on length mismatch, never throws). */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

export function createOperatorAuth({ password, ttlMs = 12 * 3600_000, now = Date.now } = {}) {
  const enabled = typeof password === 'string' && password.length > 0
  const key = enabled
    ? crypto.createHash('sha256').update(`street-arcade:operator:${password}`).digest()
    : null

  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url')

  /** @returns {string} cookie value valid for ttlMs, carrying `subject` */
  function issue(subject = 'admin') {
    const exp = String(now() + ttlMs)
    const sub = Buffer.from(String(subject)).toString('base64url')
    return `${exp}.${sub}.${sign(`${exp}.${sub}`)}`
  }

  /** @returns {string|null} the subject when the token is valid and not expired */
  function verify(token) {
    if (!enabled || typeof token !== 'string') return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [exp, sub, sig] = parts
    if (!/^\d+$/.test(exp) || Number(exp) < now() || !sub) return null
    if (!safeEqual(sig, sign(`${exp}.${sub}`))) return null
    try { return Buffer.from(sub, 'base64url').toString() } catch { return null }
  }

  /** Password check for the login form and `Authorization: Bearer`. */
  function checkPassword(candidate) {
    return enabled && safeEqual(String(candidate ?? ''), password)
  }

  return { enabled, ttlMs, issue, verify, checkPassword }
}

/** Minimal Cookie header parser (no dependency on @fastify/cookie). */
export function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    if (!(k in out)) {
      try { out[k] = decodeURIComponent(part.slice(i + 1).trim()) } catch { /* malformed */ }
    }
  }
  return out
}

/**
 * The path a router / static server ends up resolving: percent-decoded,
 * backslashes and repeated slashes folded, dot segments resolved. Page guards
 * compare THIS, so /index%2Ehtml or /%64ocumentation can't slip past them.
 * @returns {string|null} null when the path can't be decoded (reject it)
 */
export function canonicalPath(url) {
  const raw = String(url ?? '/').split('?')[0]
  let decoded
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (decoded.includes('\0')) return null
  const folded = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  try { return new URL(folded, 'http://x').pathname } catch { return null }
}

/** Per-totem key the game/bridge sends in `X-Totem-Key`. */
export function newTotemKey() {
  return crypto.randomBytes(18).toString('base64url')
}
