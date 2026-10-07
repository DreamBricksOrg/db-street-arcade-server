// src/plugins/auth.js
// Operator login + route guards. Registered FIRST so its onRequest hook
// covers every route (static pages included).
//
//   config: { operator: true }  → 401 unless the request is the operator
//   GET  /  (dashboard)         → 302 /login when not logged in
//   /documentation              → operator only in production
//
// Operator = valid `sa_op` cookie (POST /api/auth/login) or
// `Authorization: Bearer <OPERATOR_PASSWORD>` (scripts, curl).
// Without OPERATOR_PASSWORD (allowed only in development) auth is off and
// everyone is the operator — env.js refuses to boot production without it.
//
// Game-facing routes (end-session, the bridge's queue view) use
// fastify.isGameCaller(request, totem): operator, or the totem's own key in
// `X-Totem-Key`. Totems created before keys existed have none and stay open
// until the operator generates one (dashboard → Editar → Chave do jogo).

import fp from 'fastify-plugin'
import { env } from '../config/env.js'
import { createOperatorAuth, parseCookies, safeEqual, COOKIE_NAME } from '../lib/auth.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('auth')

const loginRateLimit = createRateLimiter({ windowMs: 60_000, max: 10 })

async function authPlugin(fastify) {
  const auth = createOperatorAuth({ password: env.operatorPassword })
  if (!auth.enabled) log.warn('OPERATOR_PASSWORD not set — dashboard and operator API are OPEN (development only)')

  const secureCookie = env.publicUrl.startsWith('https://')

  function isOperator(request) {
    if (!auth.enabled) return true
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
    if (bearer && auth.checkPassword(bearer)) return true
    return auth.verify(parseCookies(request.headers.cookie)[COOKIE_NAME])
  }

  /** Operator, or the caller holds this totem's key. Legacy totems (no key) stay open. */
  function isGameCaller(request, totem) {
    if (isOperator(request)) return true
    if (!totem?.gameKey) return true
    return safeEqual(String(request.headers['x-totem-key'] ?? ''), totem.gameKey)
  }

  fastify.decorate('operatorAuth', auth)
  fastify.decorate('isOperator', isOperator)
  fastify.decorate('isGameCaller', isGameCaller)

  fastify.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]

    if (request.routeOptions.config?.operator && !isOperator(request)) {
      return reply.status(401).send({ error: 'Operator login required' })
    }

    if ((path === '/' || path === '/index.html') && !isOperator(request)) {
      return reply.redirect('/login', 302)
    }

    if (path.startsWith('/documentation') && env.isProd && !isOperator(request)) {
      return reply.redirect('/login?next=/documentation', 302)
    }
  })

  fastify.get('/login', { schema: { hide: true } }, async (request, reply) => {
    if (isOperator(request)) return reply.redirect('/', 302)
    return reply.sendFile('login.html')
  })

  fastify.post('/api/auth/login', {
    preHandler: loginRateLimit,
    schema: {
      tags: ['Auth'], summary: 'Operator login (sets the sa_op cookie)',
      body: { type: 'object', properties: { password: { type: 'string' } }, required: ['password'] },
    },
  }, async (request, reply) => {
    if (!auth.enabled) return { ok: true }
    if (!auth.checkPassword(request.body.password)) {
      log.warn({ ip: request.ip }, 'Failed operator login')
      return reply.status(401).send({ error: 'Senha incorreta' })
    }
    const maxAge = Math.floor(auth.ttlMs / 1000)
    reply.header('Set-Cookie',
      `${COOKIE_NAME}=${auth.issue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`)
    log.info({ ip: request.ip }, 'Operator logged in')
    return { ok: true }
  })

  fastify.post('/api/auth/logout', { schema: { tags: ['Auth'] } }, async (_request, reply) => {
    reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? '; Secure' : ''}`)
    return { ok: true }
  })

  fastify.get('/api/auth/me', { schema: { tags: ['Auth'] } }, async (request) => ({
    operator: isOperator(request),
    authEnabled: auth.enabled,
  }))
}

export default fp(authPlugin, { name: 'auth' })
