// src/plugins/auth.js
// Operator login, route guards and the activity log hook. Registered FIRST so
// its hooks cover every route (static pages included).
//
//   config: { operator: true }        → 401 unless an operator is logged in
//   config: { role: 'admin' }         → 403 unless that operator is an admin
//   GET  /  (dashboard)               → 302 /login when not logged in
//   /documentation                    → operator only in production
//   non-GET /api/* by an operator     → written to the activity log
//
// Who is the operator (resolved once per request into request.operator):
//   - an account from the `users` collection (cookie from POST /api/auth/login)
//   - the bootstrap `admin`: OPERATOR_PASSWORD at login (user "admin" or
//     blank) or as `Authorization: Bearer <OPERATOR_PASSWORD>` for scripts.
// Without OPERATOR_PASSWORD (allowed only in development) auth is off and
// every request is a "dev" admin — env.js refuses to boot production without it.
//
// Game-facing routes (end-session, the bridge's queue/ranking) use
// fastify.isGameCaller(request, totem): operator, or the totem's own key in
// `X-Totem-Key`. Totems created before keys existed have none and stay open
// until the operator generates one (dashboard → Editar → Chave do jogo).

import fp from 'fastify-plugin'
import { env } from '../config/env.js'
import { createOperatorAuth, parseCookies, safeEqual, canonicalPath, COOKIE_NAME } from '../lib/auth.js'
import { verifyPassword } from '../lib/passwords.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { createLogger } from '../lib/logger.js'
import { sanitizeDetails } from '../modules/users/users.routes.js'

const log = createLogger('auth')

const BOOTSTRAP_ADMIN = Object.freeze({ id: 'admin', username: 'admin', name: 'Administrador', role: 'admin' })
const DEV_OPERATOR    = Object.freeze({ id: 'dev', username: 'dev', name: 'Desenvolvimento', role: 'admin' })

async function authPlugin(fastify) {
  const auth = createOperatorAuth({ password: env.operatorPassword })
  if (!auth.enabled) log.warn('OPERATOR_PASSWORD not set — dashboard and operator API are OPEN (development only)')

  const secureCookie = env.publicUrl.startsWith('https://')
  // 10 attempts/min per IP, counted in Redis across processes when available
  // (registered after this plugin; looked up at request time).
  const loginRateLimit = createRateLimiter({
    name: 'login', windowMs: 60_000, max: 10,
    getRedis: () => fastify.redisPublisher,
  })

  const cookie = (value, maxAge) =>
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`

  /** @returns {Promise<{id,username,name,role}|null>} */
  async function resolveOperator(request) {
    if (!auth.enabled) return DEV_OPERATOR
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
    if (bearer && auth.checkPassword(bearer)) return BOOTSTRAP_ADMIN
    const subject = auth.verify(parseCookies(request.headers.cookie)[COOKIE_NAME])
    if (!subject) return null
    if (subject === 'admin') return BOOTSTRAP_ADMIN
    const [id, version] = subject.split(':')
    const user = await fastify.users?.findById(id).catch(() => null)
    if (!user || user.disabled || String(user.tokenVersion) !== version) return null
    return { id: user._id, username: user.username, name: user.name, role: user.role }
  }

  const isOperator = (request) => Boolean(request.operator)

  /** Operator, or the caller holds this totem's key. Legacy totems (no key) stay open. */
  function isGameCaller(request, totem) {
    if (isOperator(request)) return true
    if (!totem?.gameKey) return true
    return safeEqual(String(request.headers['x-totem-key'] ?? ''), totem.gameKey)
  }

  fastify.decorateRequest('operator', null)
  fastify.decorate('operatorAuth', auth)
  fastify.decorate('isOperator', isOperator)
  fastify.decorate('isGameCaller', isGameCaller)

  fastify.addHook('onRequest', async (request, reply) => {
    const hasCredentials = !auth.enabled || request.headers.cookie || request.headers.authorization
    request.operator = hasCredentials ? await resolveOperator(request) : null

    const config = request.routeOptions.config ?? {}
    if (config.operator && !request.operator) {
      return reply.status(401).send({ error: 'Operator login required' })
    }
    if (config.role === 'admin' && request.operator?.role !== 'admin') {
      return reply.status(403).send({ error: 'Só administradores podem fazer isso' })
    }

    // Page guards compare the resolved path, never the raw URL (encoded
    // variants like /index%2Ehtml or /%64ocumentation must not bypass them).
    const path = canonicalPath(request.url)
    if (path === null) return reply.status(400).send({ error: 'Bad path' })

    if ((path === '/' || path === '/index.html') && !request.operator) {
      return reply.redirect('/login', 302)
    }

    const docs = path === '/documentation' || path.startsWith('/documentation/') ||
      (request.routeOptions.url ?? '').startsWith('/documentation')
    if (docs && env.isProd && !request.operator) {
      return reply.redirect('/login?next=/documentation', 302)
    }
  })

  // Activity log: every successful change an operator makes through the API.
  fastify.addHook('onResponse', async (request, reply) => {
    if (!request.operator || request.method === 'GET' || reply.statusCode >= 400) return
    const route = request.routeOptions.url ?? ''
    if (!route.startsWith('/api/') || route.startsWith('/api/auth/')) return
    await fastify.audit?.record({
      operator: request.operator,
      action: request.routeOptions.config?.audit ?? `${request.method} ${route}`,
      method: request.method,
      url: route,
      target: request.params && Object.keys(request.params).length ? request.params : null,
      status: reply.statusCode,
      details: sanitizeDetails(request.body),
      ip: request.ip,
    })
  })

  fastify.get('/login', { schema: { hide: true } }, async (request, reply) => {
    if (request.operator) return reply.redirect('/', 302)
    return reply.sendFile('login.html')
  })

  fastify.post('/api/auth/login', {
    preHandler: loginRateLimit,
    schema: {
      tags: ['Auth'], summary: 'Operator login (sets the sa_op cookie). Blank user or "admin" = OPERATOR_PASSWORD',
      body: {
        type: 'object', required: ['password'],
        properties: { username: { type: 'string', maxLength: 64 }, password: { type: 'string', maxLength: 200 } },
      },
    },
  }, async (request, reply) => {
    if (!auth.enabled) return { ok: true, user: DEV_OPERATOR }
    const username = String(request.body.username ?? '').trim().toLowerCase()

    let operator = null
    let subject = null
    if (!username || username === 'admin') {
      if (auth.checkPassword(request.body.password)) { operator = BOOTSTRAP_ADMIN; subject = 'admin' }
    } else {
      const user = await fastify.users?.findByUsername(username)
      if (user && !user.disabled && await verifyPassword(request.body.password, user.passwordHash)) {
        operator = { id: user._id, username: user.username, name: user.name, role: user.role }
        subject = `${user._id}:${user.tokenVersion}`
        fastify.users.touchLogin(user._id)
      }
    }

    if (!operator) {
      log.warn({ ip: request.ip, username: username || 'admin' }, 'Failed operator login')
      await fastify.audit?.record({ operator: null, action: 'auth.login_failed', details: { username: username || 'admin' }, ip: request.ip, status: 401 })
      return reply.status(401).send({ error: 'Usuário ou senha incorretos' })
    }

    reply.header('Set-Cookie', cookie(auth.issue(subject), Math.floor(auth.ttlMs / 1000)))
    await fastify.audit?.record({ operator, action: 'auth.login', ip: request.ip, status: 200 })
    log.info({ ip: request.ip, username: operator.username }, 'Operator logged in')
    return { ok: true, user: operator }
  })

  fastify.post('/api/auth/logout', { schema: { tags: ['Auth'] } }, async (request, reply) => {
    if (request.operator) await fastify.audit?.record({ operator: request.operator, action: 'auth.logout', ip: request.ip, status: 200 })
    reply.header('Set-Cookie', cookie('', 0))
    return { ok: true }
  })

  fastify.get('/api/auth/me', { schema: { tags: ['Auth'] } }, async (request) => ({
    operator: Boolean(request.operator),
    authEnabled: auth.enabled,
    user: request.operator,
  }))
}

export default fp(authPlugin, { name: 'auth' })
