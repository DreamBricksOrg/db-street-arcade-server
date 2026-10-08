// src/modules/users/users.routes.js
// Operator accounts (admin only) and the activity log.
//
//   GET    /api/users            list (no password hashes)
//   POST   /api/users            { username, name, password, role }
//   PUT    /api/users/:id        { name?, role?, disabled?, password? }
//   DELETE /api/users/:id
//   GET    /api/audit            activity log (?limit, ?before, ?username, ?action)
//
// The bootstrap account `admin` (OPERATOR_PASSWORD) is virtual — not stored
// here — so nobody can lock themselves out by deleting the last admin.
// Changing a password or disabling an account bumps tokenVersion, which
// invalidates that user's existing login cookies.

import crypto from 'node:crypto'
import fp from 'fastify-plugin'
import { hashPassword, passwordProblem } from '../../lib/passwords.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('users')
const CACHE_MS = 10_000
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/
const ROLES = ['admin', 'operator']
export const RESERVED_USERNAMES = new Set(['admin', 'dev', 'root', 'system'])
const AUDIT_TTL_DAYS = 180

const publicUser = (u) => ({
  id: u._id, username: u.username, name: u.name, role: u.role,
  disabled: Boolean(u.disabled), createdAt: u.createdAt, updatedAt: u.updatedAt,
  lastLoginAt: u.lastLoginAt ?? null,
})

/** Body fields worth keeping in the activity log (never secrets). */
export function sanitizeDetails(body) {
  if (!body || typeof body !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(body)) {
    if (/password|secret|token|key/i.test(k)) { out[k] = '***'; continue }
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = typeof v === 'string' ? v.slice(0, 200) : v
    else if (Array.isArray(v)) out[k] = `[${v.length} itens]`
    else out[k] = '{…}'
  }
  return Object.keys(out).length ? out : null
}

async function usersRoutes(fastify) {
  if (!fastify.mongo) return
  const db = fastify.mongo.client.db()
  const users = db.collection('users')
  const audit = db.collection('audit')

  await users.createIndex({ username: 1 }, { name: 'users_username', unique: true })
  await audit.createIndex({ at: -1 }, { name: 'audit_at' })
  await audit.createIndex({ at: 1 }, { name: 'audit_ttl', expireAfterSeconds: AUDIT_TTL_DAYS * 86_400 })
    .catch(() => {})   // differs only in options on old deploys — keep going

  // ── Service used by the auth plugin ───────────────────────────────────────
  const cache = new Map()   // id → { user, at }
  async function findById(id) {
    const hit = cache.get(id)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.user
    const user = await users.findOne({ _id: id })
    cache.set(id, { user, at: Date.now() })
    return user
  }
  const findByUsername = (username) => users.findOne({ username: String(username ?? '').toLowerCase() })
  const touchLogin = (id) => users.updateOne({ _id: id }, { $set: { lastLoginAt: new Date() } }).catch(() => {})

  async function record({ operator, action, method = null, url = null, target = null, status = null, details = null, ip = null }) {
    try {
      await audit.insertOne({
        at: new Date(),
        userId: operator?.id ?? null, username: operator?.username ?? null, name: operator?.name ?? null,
        action, method, url, target, status, details, ip,
      })
    } catch (err) {
      log.warn({ err: err.message, action }, 'Audit write failed')
    }
  }

  fastify.decorate('users', { findById, findByUsername, touchLogin })
  fastify.decorate('audit', { record })

  // ── Routes ────────────────────────────────────────────────────────────────
  const ADMIN = { operator: true, role: 'admin' }
  const userShape = {
    type: 'object',
    properties: {
      id: { type: 'string' }, username: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' },
      disabled: { type: 'boolean' }, createdAt: { type: 'string' }, updatedAt: { type: 'string' },
      lastLoginAt: { type: 'string', nullable: true },
    },
  }
  const error = { type: 'object', properties: { error: { type: 'string' } } }

  fastify.get('/api/users', {
    config: ADMIN,
    schema: { tags: ['Users'], summary: 'Operator accounts', response: { 200: { type: 'array', items: userShape } } },
  }, async () => (await users.find({}, { sort: { username: 1 } }).toArray()).map(publicUser))

  fastify.post('/api/users', {
    config: { ...ADMIN, audit: 'user.create' },
    schema: {
      tags: ['Users'], summary: 'Create an operator account',
      body: {
        type: 'object', required: ['username', 'name', 'password', 'role'],
        properties: {
          username: { type: 'string' }, name: { type: 'string', minLength: 1, maxLength: 60 },
          password: { type: 'string' }, role: { type: 'string', enum: ROLES },
        },
      },
      response: { 201: userShape, 400: error, 409: error },
    },
  }, async (request, reply) => {
    const username = String(request.body.username).trim().toLowerCase()
    if (!USERNAME_RE.test(username)) return reply.status(400).send({ error: 'Usuário: 3 a 32 caracteres, só letras minúsculas, números, ponto, hífen e sublinhado.' })
    if (RESERVED_USERNAMES.has(username)) return reply.status(400).send({ error: `"${username}" é reservado.` })
    const problem = passwordProblem(request.body.password)
    if (problem) return reply.status(400).send({ error: problem })
    const now = new Date()
    const doc = {
      _id: crypto.randomUUID(), username, name: request.body.name.trim(), role: request.body.role,
      passwordHash: await hashPassword(request.body.password), tokenVersion: 1, disabled: false,
      createdAt: now, updatedAt: now, createdBy: request.operator?.username ?? null,
    }
    try {
      await users.insertOne(doc)
    } catch (err) {
      if (err.code === 11000) return reply.status(409).send({ error: `O usuário "${username}" já existe.` })
      throw err
    }
    return reply.status(201).send(publicUser(doc))
  })

  fastify.put('/api/users/:id', {
    config: { ...ADMIN, audit: 'user.update' },
    schema: {
      tags: ['Users'], summary: 'Update an operator account',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 }, role: { type: 'string', enum: ROLES },
          disabled: { type: 'boolean' }, password: { type: 'string' },
        },
      },
      response: { 200: userShape, 400: error, 404: error },
    },
  }, async (request, reply) => {
    const user = await users.findOne({ _id: request.params.id })
    if (!user) return reply.status(404).send({ error: 'Usuário não encontrado' })
    const { name, role, disabled, password } = request.body ?? {}
    if (request.operator?.id === user._id && (disabled === true || (role && role !== 'admin'))) {
      return reply.status(400).send({ error: 'Você não pode desativar nem rebaixar a própria conta.' })
    }
    const set = { updatedAt: new Date() }
    const inc = {}
    if (name !== undefined) set.name = name.trim()
    if (role !== undefined) set.role = role
    if (disabled !== undefined) { set.disabled = disabled; if (disabled) inc.tokenVersion = 1 }
    if (password !== undefined) {
      const problem = passwordProblem(password)
      if (problem) return reply.status(400).send({ error: problem })
      set.passwordHash = await hashPassword(password)
      inc.tokenVersion = 1   // logs this user out everywhere
    }
    await users.updateOne({ _id: user._id }, { $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}) })
    cache.delete(user._id)
    return publicUser(await users.findOne({ _id: user._id }))
  })

  fastify.delete('/api/users/:id', {
    config: { ...ADMIN, audit: 'user.delete' },
    schema: {
      tags: ['Users'], summary: 'Delete an operator account',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      response: { 204: { type: 'null' }, 400: error, 404: error },
    },
  }, async (request, reply) => {
    if (request.operator?.id === request.params.id) return reply.status(400).send({ error: 'Você não pode excluir a própria conta.' })
    const res = await users.deleteOne({ _id: request.params.id })
    cache.delete(request.params.id)
    if (!res.deletedCount) return reply.status(404).send({ error: 'Usuário não encontrado' })
    return reply.status(204).send()
  })

  fastify.get('/api/audit', {
    config: ADMIN,
    schema: {
      tags: ['Users'], summary: 'Activity log (who did what)',
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500 },
          before: { type: 'string' },    // ISO date: older than this (pagination)
          username: { type: 'string' },
          action: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { limit = 100, before, username, action } = request.query
    const q = {}
    if (before && !Number.isNaN(Date.parse(before))) q.at = { $lt: new Date(before) }
    if (username) q.username = String(username).toLowerCase()
    if (action) q.action = { $regex: `^${String(action).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }
    const rows = await audit.find(q, { sort: { at: -1 }, limit, projection: { _id: 0 } }).toArray()
    return rows
  })
}

export default fp(usersRoutes, { name: 'users-routes' })
