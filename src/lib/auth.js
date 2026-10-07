// src/lib/auth.js
// Operator auth primitives — pure, no I/O, clock injectable for tests.
//
// The operator logs in with OPERATOR_PASSWORD and gets an HMAC-signed cookie
// `sa_op=<expiresAtMs>.<sig>`. The signing key is derived from the password,
// so every backend process accepts the same cookie (no shared session store)
// and changing the password logs everyone out.

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

  /** @returns {string} cookie value valid for ttlMs */
  function issue() {
    const exp = String(now() + ttlMs)
    return `${exp}.${sign(exp)}`
  }

  /** @returns {boolean} */
  function verify(token) {
    if (!enabled || typeof token !== 'string') return false
    const dot = token.indexOf('.')
    if (dot <= 0) return false
    const exp = token.slice(0, dot)
    if (!/^\d+$/.test(exp) || Number(exp) < now()) return false
    return safeEqual(token.slice(dot + 1), sign(exp))
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

/** Per-totem key the game/bridge sends in `X-Totem-Key`. */
export function newTotemKey() {
  return crypto.randomBytes(18).toString('base64url')
}
