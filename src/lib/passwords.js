// src/lib/passwords.js
// Operator account passwords: scrypt (node:crypto, no dependency).
// Stored as `scrypt$<N>$<saltB64url>$<hashB64url>`.

import crypto from 'node:crypto'

const N = 16384, R = 8, P = 1, KEYLEN = 32
export const MIN_PASSWORD_LENGTH = 10

const scrypt = (password, salt, n) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, KEYLEN, { N: n, r: R, p: P, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))))

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = await scrypt(String(password), salt, N)
  return `scrypt$${N}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$')
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  if (!Number.isInteger(n) || n < 1024 || n > 1 << 20) return false
  const expected = Buffer.from(parts[3], 'base64url')
  const key = await scrypt(String(password ?? ''), Buffer.from(parts[2], 'base64url'), n)
  return key.length === expected.length && crypto.timingSafeEqual(key, expected)
}

/** null when acceptable, otherwise the reason (pt-BR, shown to the admin). */
export function passwordProblem(password) {
  const p = String(password ?? '')
  if (p.length < MIN_PASSWORD_LENGTH) return `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`
  if (p.length > 200) return 'Senha longa demais.'
  return null
}
