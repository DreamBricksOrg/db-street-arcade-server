// src/modules/udp/udp.dispatcher.js
// TASK-U5.3 — Subscriber Redis → UDP Dispatcher
// TASK-U5.4 — Mapa Sessão → IP do Totem
//
// Bridges Redis Pub/Sub (game:input:*) → UDP datagrams → Totem Unity.
//
// Packet format per PLAN TASK-U5.2 — JSON compacto < 512 bytes:
//   { sid, pid, a, s, ts }
//   sid  = primeiros 8 chars do sessionId
//   pid  = primeiros 8 chars do playerId
//   a    = action (ex: "btn_A")
//   s    = 1 (pressed) | 0 (released)
//   ts   = timestamp truncado (últimos 7 dígitos de Date.now())
//
// Totem address resolution (3-layer, in-memory cache first):
//   1. In-memory Map (fastest)
//   2. Redis HASH cache
//   3. MongoDB fallback

import { parseMessage } from '../../lib/channels.js'
import { SessionKey }   from '../../lib/channels.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('udp.dispatcher')

export class UdpDispatcher {
  /**
   * @param {import('fastify').FastifyInstance} fastify
   */
  constructor(fastify) {
    this.udpSend    = fastify.udpSend
    this.subscriber = fastify.redisSubscriber
    this.redis      = fastify.redisPublisher  // used for HGET (read-only commands ok on publisher)
    this.mongo      = fastify.mongo ?? null

    /**
     * In-memory totem registry.
     * sessionId → Array<{ ip: string, udpPort: number }>
     * @type {Map<string, Array<{ip: string, udpPort: number}>>}
     */
    this.totemMap = new Map()
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Subscribes to game:input:* via pattern subscription.
   * Called once after all plugins are ready.
   */
  async start() {
    await this.subscriber.psubscribe('game:input:*')

    this.subscriber.on('pmessage', (_pattern, _channel, raw) => {
      this._handleMessage(raw).catch((err) =>
        log.error({ err: err.message }, 'Dispatcher error')
      )
    })

    log.info("Subscribed to 'game:input:*'")
  }

  /**
   * Registers totem addresses for a session.
   * Called by GameHandler.onConnect() when a player joins.
   * @param {string} sessionId
   * @param {Array<{id?: string, ip: string, udpPort: number}>} totems
   */
  registerSession(sessionId, totems) {
    if (!Array.isArray(totems) || !totems.length) return
    this.totemMap.set(sessionId, totems)
    log.debug({ sessionId, count: totems.length }, 'Totems registered')
  }

  /**
   * Removes totem registration when a session ends.
   * @param {string} sessionId
   */
  unregisterSession(sessionId) {
    this.totemMap.delete(sessionId)
    log.debug({ sessionId }, 'Totems unregistered')
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  async _handleMessage(raw) {
    const msg = parseMessage(raw)

    // Only process 'input' type messages
    if (!msg || msg.type !== 'input') return

    const { sessionId, playerId, data, ts } = msg
    const { action, state } = data ?? {}

    if (!sessionId || !action || !state) {
      log.warn({ sessionId }, 'Malformed input message — skipping')
      return
    }

    // Resolve totems for this session
    const totems = await this._resolveTotems(sessionId)

    if (!totems.length) {
      log.debug({ sessionId }, 'No totems for session — UDP skipped')
      return
    }

    // Build compact packet per PLAN U5.2
    const packet = this._buildPacket(sessionId, playerId, action, state, ts)

    // Fire to all totems (usually 1; Promise.allSettled allows partial failure)
    await Promise.allSettled(
      totems.map(({ ip, udpPort }) =>
        this.udpSend(ip, udpPort, packet).catch((err) =>
          log.error({ ip, udpPort, err: err.message }, 'UDP send error')
        )
      )
    )
  }

  /**
   * Builds the compact JSON packet per PLAN TASK-U5.2.
   * Always < 512 bytes.
   */
  _buildPacket(sessionId, playerId, action, state, ts) {
    return JSON.stringify({
      sid: sessionId.slice(0, 8),
      pid: (playerId ?? '').slice(0, 8),
      a:   action,
      s:   state === 'pressed' ? 1 : 0,
      ts:  Number(String(ts ?? Date.now()).slice(-7)),
    })
  }

  /**
   * 3-layer totem resolution:
   *   1. In-memory map
   *   2. Redis HASH (session:{id})
   *   3. MongoDB sessions collection
   */
  async _resolveTotems(sessionId) {
    // 1. In-memory
    if (this.totemMap.has(sessionId)) {
      return this.totemMap.get(sessionId)
    }

    // 2. Redis HASH
    if (this.redis) {
      try {
        const raw = await this.redis.hget(SessionKey(sessionId), 'totems')
        if (raw) {
          const totems = JSON.parse(raw)
          if (Array.isArray(totems) && totems.length) {
            this.totemMap.set(sessionId, totems)
            return totems
          }
        }
      } catch (err) {
        log.warn({ err: err.message, sessionId }, 'Redis HGET failed — falling back to Mongo')
      }
    }

    // 3. MongoDB
    if (this.mongo) {
      try {
        const doc = await this.mongo.db.collection('sessions').findOne(
          { _id: sessionId },
          { projection: { totems: 1 } }
        )
        if (doc?.totems?.length) {
          this.totemMap.set(sessionId, doc.totems)
          return doc.totems
        }
      } catch (err) {
        log.warn({ err: err.message, sessionId }, 'MongoDB lookup failed')
      }
    }

    return []
  }
}
