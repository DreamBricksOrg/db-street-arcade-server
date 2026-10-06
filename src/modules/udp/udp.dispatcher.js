// src/modules/udp/udp.dispatcher.js
// TASK-U5.3 — Subscriber Redis → game input dispatcher
// TASK-U5.4 — Mapa Sessão → destino do jogo
//
// Bridges Redis Pub/Sub (game:input:*) → GameOutput, which delivers to the
// physical totem over UDP (instance 'default') or to the embedded iframe over
// SSE (any other instance). Name kept for history — it is no longer UDP-only.
//
// Packet format per PLAN TASK-U5.2 — JSON compacto < 512 bytes:
//   { sid, pid, a, s, ts }
//   sid  = primeiros 8 chars do sessionId
//   pid  = primeiros 8 chars do playerId
//   a    = action (ex: "btn_A")
//   s    = 1 (pressed) | 0 (released)
//   ts   = timestamp truncado (últimos 7 dígitos de Date.now())
//
// Session target resolution (3-layer, in-memory cache first):
//   1. In-memory Map (fastest)
//   2. Redis HASH cache
//   3. MongoDB fallback

import { parseMessage, SessionKey } from '../../lib/channels.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('udp.dispatcher')

export class UdpDispatcher {
  /**
   * @param {import('fastify').FastifyInstance} fastify  (redisSubscriber, redisPublisher, mongo, gameOutput)
   */
  constructor(fastify) {
    this.output     = fastify.gameOutput
    this.subscriber = fastify.redisSubscriber
    this.redis      = fastify.redisPublisher  // used for HGETALL (read-only commands ok on publisher)
    this.mongo      = fastify.mongo ?? null

    /**
     * sessionId → { totemId, instanceId, totems }
     * @type {Map<string, {totemId: string|null, instanceId: string, totems: Array<{ip: string, udpPort: number}>}>}
     */
    this.targets = new Map()
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start() {
    await Promise.all([
      this.subscriber.psubscribe('game:input:*'),
      this.subscriber.psubscribe('game:event:*'),
    ])

    this.subscriber.on('pmessage', (pattern, _channel, raw) => {
      if (pattern === 'game:input:*') {
        this._handleMessage(raw).catch((err) =>
          log.error({ err: err.message }, 'Dispatcher input error')
        )
      } else if (pattern === 'game:event:*') {
        this._handleEvent(raw).catch((err) =>
          log.error({ err: err.message }, 'Dispatcher event error')
        )
      }
    })

    log.info("Subscribed to 'game:input:*' and 'game:event:*'")
  }

  /**
   * Caches where a session's packets go. Called by GameHandler.onConnect().
   * @param {string} sessionId
   * @param {{ totemId?: string, instanceId?: string, totems?: Array }} session
   */
  registerSession(sessionId, session) {
    this.targets.set(sessionId, this._toTarget(session))
    log.debug({ sessionId, instanceId: session.instanceId }, 'Session target registered')
  }

  /** @param {string} sessionId */
  unregisterSession(sessionId) {
    this.targets.delete(sessionId)
    log.debug({ sessionId }, 'Session target unregistered')
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _toTarget(s) {
    return {
      totemId:    s.totemId ?? null,
      instanceId: s.instanceId ?? 'default',
      totems:     Array.isArray(s.totems) ? s.totems : [],
    }
  }

  async _handleMessage(raw) {
    const msg = parseMessage(raw)
    if (!msg || msg.type !== 'input') return

    const { sessionId, playerId, data, ts } = msg
    const { action, state } = data ?? {}

    if (!sessionId || !action || !state) {
      log.warn({ sessionId }, 'Malformed input message — skipping')
      return
    }

    const target = await this._resolveTarget(sessionId)
    if (!target) {
      log.debug({ sessionId }, 'No target for session — input skipped')
      return
    }

    await this.output.send(target, this._buildPacket(sessionId, playerId, action, state, ts))
  }

  async _handleEvent(raw) {
    const msg = parseMessage(raw)
    if (!msg || msg.type !== 'event') return

    const { sessionId, data } = msg
    if (data?.event === 'session_ended') {
      this.unregisterSession(sessionId)
    }
  }

  /** Builds the compact packet per PLAN TASK-U5.2 (always < 512 bytes). */
  _buildPacket(sessionId, playerId, action, state, ts) {
    return {
      sid: sessionId.slice(0, 8),
      pid: (playerId ?? '').slice(0, 8),
      a:   action,
      s:   state === 'pressed' ? 1 : 0,
      ts:  Number(String(ts ?? Date.now()).slice(-7)),
    }
  }

  async _resolveTarget(sessionId) {
    // 1. In-memory
    if (this.targets.has(sessionId)) return this.targets.get(sessionId)

    // 2. Redis HASH
    if (this.redis) {
      try {
        const raw = await this.redis.hgetall(SessionKey(sessionId))
        if (raw?.id) {
          const target = this._toTarget({
            totemId:    raw.totemId || null,
            instanceId: raw.instanceId || 'default',
            totems:     JSON.parse(raw.totems || '[]'),
          })
          this.targets.set(sessionId, target)
          return target
        }
      } catch (err) {
        log.warn({ err: err.message, sessionId }, 'Redis HGETALL failed — falling back to Mongo')
      }
    }

    // 3. MongoDB
    if (this.mongo) {
      try {
        const doc = await this.mongo.db.collection('sessions').findOne(
          { _id: sessionId },
          { projection: { totemId: 1, instanceId: 1, totems: 1 } },
        )
        if (doc) {
          const target = this._toTarget(doc)
          this.targets.set(sessionId, target)
          return target
        }
      } catch (err) {
        log.warn({ err: err.message, sessionId }, 'MongoDB lookup failed')
      }
    }

    return null
  }
}
