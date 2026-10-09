// src/modules/embed/embed.routes.js
// n→n: a totem embedded as an <iframe> on any site. Every page load becomes
// its own INSTANCE (own queue, sessions, QR and phones).
//
//   GET  /embed/:totemId                 → 302 /embed/:totemId/<new id>/
//   GET  /embed/:totemId/:inst/          → the game's index.html + QR overlay
//   GET  /embed/:totemId/:inst/events    → SSE: player_join / inputs / player_leave
//   POST /embed/:totemId/:inst/end-session  { pid }  → player died
//   GET  /embed/:totemId/:inst/queue-state → HUD data (sessions + queue)
//   GET  /embed/:totemId/:inst/config    → totem.gameConfig
//   GET  /embed/:totemId/:inst/<file>    → static file of games/<game>/public
//
// These are the exact endpoints games/*/server.js offers a physical totem's
// browser, so the games run unchanged — they only use RELATIVE urls.
//
// Encapsulated plugin (no fastify-plugin): the CSP hook below applies only here.

import fs     from 'node:fs/promises'
import path   from 'node:path'
import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import { gamePublicDir } from '../../lib/games.js'
import { createLogger }  from '../../lib/logger.js'
import { instanceKey }   from '../../lib/channels.js'
import { RANGES, rankingSince } from '../../lib/stats.js'
import { SessionRepository } from '../session/session.repository.js'

const log = createLogger('embed.routes')

const OVERLAY_TAGS =
  '<link rel="stylesheet" href="/embed-assets/overlay.css">\n' +
  '<script src="/embed-assets/overlay.js" defer></script>\n'

const totemParam = { type: 'string', minLength: 36, maxLength: 36 }
const instParam  = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }
const instParams = {
  type: 'object',
  properties: { totemId: totemParam, instanceId: instParam },
  required: ['totemId', 'instanceId'],
}

/**
 * Site that embedded the iframe: the Referer of the iframe's own navigation
 * (browsers send the parent's origin cross-site). Our own host = the
 * dashboard's preview.
 */
function embeddingSite(request) {
  try {
    const ref = new URL(request.headers.referer)
    return ref.host === request.headers.host ? 'preview' : ref.origin
  } catch {
    return null
  }
}

/** Visitor IP. X-Forwarded-For is only trusted behind a known proxy. */
function clientIp(request) {
  if (env.trustProxy) {
    const xff = request.headers['x-forwarded-for']
    if (xff) return String(xff).split(',')[0].trim()
  }
  return request.socket?.remoteAddress ?? null
}

export default async function embedRoutes(fastify) {
  if (!fastify.mongo || !fastify.totemQueue) {
    log.warn('MongoDB/queue not available — embed routes disabled')
    return
  }

  const queue     = fastify.totemQueue
  const totems    = fastify.totemService
  const instances = fastify.instances
  const hub       = fastify.instanceHub
  const rankingRepo = new SessionRepository(fastify.mongo)

  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Content-Security-Policy', `frame-ancestors ${env.embedFrameAncestors}`)
    return payload
  })

  /** Loads the totem and checks it has an embeddable game. */
  async function loadGameTotem(totemId, reply) {
    const totem = await totems.findTotem(totemId)
    if (!totem?.game) {
      reply.status(404).type('text/plain; charset=utf-8')
        .send('Este jogo não está disponível para incorporação.')
      return null
    }
    return totem
  }

  // ── Entry: one fresh instance per load ────────────────────────────────────
  fastify.get('/embed/:totemId', {
    schema: {
      tags: ['Embed'], summary: 'Iframe entry point — redirects to a fresh instance',
      params: { type: 'object', properties: { totemId: totemParam }, required: ['totemId'] },
    },
  }, async (request, reply) => {
    const totem = await loadGameTotem(request.params.totemId, reply)
    if (!totem) return reply
    const qs = request.raw.url.includes('?') ? request.raw.url.slice(request.raw.url.indexOf('?')) : ''
    reply.header('Cache-Control', 'no-store')
    return reply.redirect(`/embed/${totem._id}/${crypto.randomUUID()}/${qs}`, 302)
  })

  // Relative URLs in the game need the trailing slash.
  fastify.get('/embed/:totemId/:instanceId', {
    schema: { tags: ['Embed'], params: instParams },
  }, async (request, reply) => {
    const { totemId, instanceId } = request.params
    const qs = request.raw.url.includes('?') ? request.raw.url.slice(request.raw.url.indexOf('?')) : ''
    return reply.redirect(`/embed/${totemId}/${instanceId}/${qs}`, 301)
  })

  // ── Game page with the QR overlay injected ────────────────────────────────
  fastify.get('/embed/:totemId/:instanceId/', {
    schema: { tags: ['Embed'], summary: 'Game page of one instance', params: instParams },
  }, async (request, reply) => {
    const totem = await loadGameTotem(request.params.totemId, reply)
    if (!totem) return reply
    if (!instances.validId(request.params.instanceId)) {
      return reply.status(400).send({ error: 'Invalid instance id' })
    }

    // Remember where this instance is embedded (stats: plays per site).
    const site = embeddingSite(request)
    if (site && fastify.redisPublisher) {
      fastify.redisPublisher
        .set(`inst:site:${instanceKey(totem._id, request.params.instanceId)}`, site, 'EX', 86_400)
        .catch(() => {})
    }

    const html = await fs.readFile(path.join(gamePublicDir(env.gamesDir, totem.game), 'index.html'), 'utf8')
    const page = html.includes('</body>')
      ? html.replace('</body>', `${OVERLAY_TAGS}</body>`)
      : html + OVERLAY_TAGS
    reply.header('Cache-Control', 'no-store')
    return reply.type('text/html; charset=utf-8').send(page)
  })

  // ── SSE: the iframe's "UDP socket" ─────────────────────────────────────────
  fastify.get('/embed/:totemId/:instanceId/events', {
    schema: { tags: ['Embed'], summary: 'Game packet stream of one instance', params: instParams },
  }, async (request, reply) => {
    const { totemId, instanceId } = request.params
    const totem = await loadGameTotem(totemId, reply)
    if (!totem) return reply

    const conn = {}
    const att  = await instances.attach(totemId, instanceId, conn, clientIp(request))
    if (!att.ok) return reply.status(att.code).send({ error: att.error })

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type':            'text/event-stream',
      'Cache-Control':           'no-cache',
      'Connection':              'keep-alive',
      'X-Accel-Buffering':       'no',
      'Content-Security-Policy': `frame-ancestors ${env.embedFrameAncestors}`,
    })
    reply.raw.write('data: {"type":"connected"}\n\n')
    reply.raw.write(`data: ${JSON.stringify({ type: 'init', totemId, instanceId })}\n\n`)
    hub.add(totemId, instanceId, reply.raw)
    fastify.opsNotify?.(totemId)
    log.info({ totemId, instanceId, ...instances.totals() }, 'Instance stream opened')

    request.raw.on('close', () => {
      hub.remove(totemId, instanceId, reply.raw)
      Promise.resolve(instances.detach(totemId, instanceId, conn))
        .then(() => fastify.opsNotify?.(totemId))
        .catch(err => log.warn({ err: err.message, totemId, instanceId }, 'Instance detach failed'))
      log.info({ totemId, instanceId }, 'Instance stream closed')
    })
  })

  // ── Death reported by the game ─────────────────────────────────────────────
  fastify.post('/embed/:totemId/:instanceId/end-session', {
    schema: {
      tags: ['Embed'], summary: 'Player died in this instance', params: instParams,
      body: {
        type: 'object',
        properties: {
          pid:   { type: 'string', minLength: 1 },
          score: { type: 'number', minimum: 0, maximum: 1e9 },   // points for the ranking (optional)
        },
      },
    },
  }, async (request, reply) => {
    const { totemId, instanceId } = request.params
    const pid = request.body?.pid
    if (!pid) return { ok: false, reason: 'missing pid' }

    const session = await queue.findCurrentByPidPrefix(totemId, instanceId, pid)
    if (!session) return reply.status(404).send({ ok: false, error: 'No live session for this player' })
    const result = await queue.endSession(session._id, 'died', { score: request.body?.score ?? null })
    if (!result.ok) return reply.status(result.code ?? 500).send({ ok: false, error: result.error })
    log.info({ totemId, instanceId, pid, sessionId: session._id }, 'Player died — session ended')
    return { ok: true, endedSessionId: session._id }
  })

  // ── Ranking of this totem (public: anonymous names and points only) ────────
  fastify.get('/embed/:totemId/:instanceId/ranking', {
    schema: {
      tags: ['Embed'], params: instParams,
      querystring: { type: 'object', properties: { range: { type: 'string', enum: [...Object.keys(RANGES), 'all'] } } },
    },
  }, async (request, reply) => {
    const totem = await loadGameTotem(request.params.totemId, reply)
    if (!totem) return reply
    const rows = await rankingRepo.listRanking({ totemId: totem._id, since: rankingSince(request.query.range ?? '24h'), limit: 10 })
    reply.header('Cache-Control', 'no-store')
    return rows.map((r, i) => ({ position: i + 1, name: r.nickname ?? 'Jogador', score: r.score }))
  })

  // ── HUD + config ──────────────────────────────────────────────────────────
  fastify.get('/embed/:totemId/:instanceId/queue-state', {
    schema: { tags: ['Embed'], params: instParams },
  }, async (request, reply) => {
    const result = await queue.operatorView(request.params.totemId, request.params.instanceId)
    if (!result.ok) return reply.status(result.code ?? 500).send({ sessions: [], queue: [], maxPlayers: 0 })
    // Public (any visitor of the iframe): counts and 8-char pids only — never
    // the players' user agent, IP or full ids.
    return {
      instanceId: result.instanceId,
      sessions:   result.sessions.map(s => ({ pid: String(s.playerId).slice(0, 8), name: s.nickname ?? null, status: s.status })),
      queue:      result.queue.map((_q, i) => ({ position: i + 1 })),
      maxPlayers:   result.maxPlayers,
      maxQueueSize: result.maxQueueSize,
      paused:       result.paused,
    }
  })

  fastify.get('/embed/:totemId/:instanceId/config', {
    schema: { tags: ['Embed'], params: instParams },
  }, async (request, reply) => {
    const totem = await loadGameTotem(request.params.totemId, reply)
    if (!totem) return reply
    reply.header('Cache-Control', 'no-store')
    // Public visitors don't need the debug column (snake); gameConfig can re-enable it.
    return { debugPanel: false, ...(totem.gameConfig ?? {}) }
  })

  // ── Static game files ─────────────────────────────────────────────────────
  fastify.get('/embed/:totemId/:instanceId/*', {
    schema: { tags: ['Embed'], hide: true },
  }, async (request, reply) => {
    const totem = await loadGameTotem(request.params.totemId, reply)
    if (!totem) return reply

    const root = gamePublicDir(env.gamesDir, totem.game)
    const rel  = request.params['*'] ?? ''   // already URL-decoded by the router
    const abs  = path.resolve(root, rel)
    if (!rel || rel.includes('\0') || !abs.startsWith(root + path.sep)) {
      return reply.status(404).send({ error: 'Not found' })
    }
    return reply.sendFile(path.relative(root, abs), root)
  })
}
