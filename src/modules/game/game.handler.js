// src/modules/game/game.handler.js
// WebSocket lifecycle for player gamepads.
//   1. On connect: CLAIM the session via TotemQueueService (reserved → active)
//   2. Forward inputs to Redis Pub/Sub (game:input:{sessionId})
//   3. Send player_join via UDP so the game spawns/keeps the avatar
//   4. Heartbeat ping/pong to kill zombies
// Disconnect does NOT end the session (allows phone reconnection); sessions
// end via death/kick/timeout in TotemQueueService.

import { Channels, buildMessage, parseMessage } from '../../lib/channels.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('game.handler')

const HEARTBEAT_INTERVAL_MS = 15_000

export class GameHandler {
  constructor(fastify) {
    this.fastify    = fastify
    this.publisher  = fastify.redisPublisher
    this.subscriber = fastify.redisSubscriber

    /** @type {Map<WebSocket, { sessionId: string, playerId: string, alive: boolean }>} */
    this.connections = new Map()

    this._startHeartbeat()
    this._setupSubscriptions()
  }

  async onConnect(socket, request) {
    const { sessionId, playerId } = request.query
    if (!sessionId || !playerId) {
      socket.close(1008, 'Missing sessionId or playerId')
      return
    }

    const queue = this.fastify.totemQueue
    if (!queue) {
      socket.close(1011, 'Queue service unavailable')
      return
    }

    const claim = await queue.claim(sessionId, playerId)
    if (!claim.ok) {
      socket.close(1008, claim.error)
      return
    }
    const session = claim.session

    this.connections.set(socket, { sessionId, playerId, alive: true })
    log.info({ sessionId, playerId, total: this.connections.size }, 'Player connected')

    socket.on('message', (raw) => this.onMessage(socket, raw))
    socket.on('close',   ()    => this.onClose(socket))
    socket.on('pong',    ()    => this._markAlive(socket))
    socket.on('error',   (err) => log.error({ err: err.message, sessionId, playerId }, 'WS error'))

    const dispatcher = this.fastify.udpDispatcher
    if (dispatcher && session.totems?.length) {
      dispatcher.registerSession(sessionId, session.totems)
    }

    // Tell the game this player is in. pid is truncated to 8 chars — the
    // same convention the input dispatcher uses, so the game can key by it.
    const joinPacket = JSON.stringify({
      type: 'player_join',
      sid:  sessionId.slice(0, 8),
      pid:  playerId.slice(0, 8),
      tid:  session.totemId ?? null,
    })
    for (const t of session.totems ?? []) {
      this.fastify.udpSend(t.ip, t.udpPort, joinPacket).catch(err =>
        log.warn({ err: err.message, totemIp: t.ip }, 'UDP player_join send failed'))
    }

    await this._publish(Channels.sessionSync(sessionId), 'sync', sessionId, playerId, {
      event: 'player_connected', playerId,
    })
  }

  async onMessage(socket, raw) {
    const meta = this.connections.get(socket)
    if (!meta) return
    const { sessionId, playerId } = meta

    let parsed
    try {
      parsed = JSON.parse(raw.toString())
    } catch {
      log.warn({ sessionId, playerId }, 'Invalid message format — not JSON')
      return
    }

    const { action, state } = parsed
    if (!action || !state) {
      log.warn({ sessionId, playerId, parsed }, 'Message missing action or state')
      return
    }

    await this._publish(Channels.gameInput(sessionId), 'input', sessionId, playerId, { action, state })
  }

  async onClose(socket) {
    const meta = this.connections.get(socket)
    if (!meta) return
    const { sessionId, playerId } = meta
    this.connections.delete(socket)
    log.info({ sessionId, playerId, remaining: this.connections.size }, 'Player disconnected')

    // Session stays live — the phone may reconnect. The sweeper/timeout or a
    // death event is what actually frees the slot.
    await this._publish(Channels.sessionSync(sessionId), 'sync', sessionId, playerId, {
      event: 'player_disconnected', playerId,
    })
  }

  /** Forcibly closes the WS of a specific player (session ended). */
  disconnectPlayer(sessionId, playerId, code = 1008, reason = 'Session ended') {
    for (const [socket, meta] of this.connections) {
      if (meta.sessionId === sessionId && meta.playerId === playerId) {
        try { socket.close(code, reason) } catch { /* already closing */ }
        this.connections.delete(socket)
      }
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  async _publish(channel, type, sessionId, playerId, data) {
    if (!this.publisher) return
    try {
      await this.publisher.publish(channel, buildMessage(type, sessionId, playerId, data))
    } catch (err) {
      log.error({ err: err.message, channel }, 'Redis publish failed')
    }
  }

  _markAlive(socket) {
    const meta = this.connections.get(socket)
    if (meta) meta.alive = true
  }

  _startHeartbeat() {
    setInterval(() => {
      for (const [socket, meta] of this.connections) {
        if (!meta.alive) {
          log.warn({ sessionId: meta.sessionId, playerId: meta.playerId }, 'Heartbeat timeout — terminating')
          socket.terminate()
          this.connections.delete(socket)
          continue
        }
        meta.alive = false
        try { socket.ping() } catch { /* socket may already be closing */ }
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  /** Broadcasts game:event:* (e.g. session_ended) to that session's sockets. */
  _setupSubscriptions() {
    if (!this.subscriber) return

    this.subscriber.psubscribe('game:event:*').catch(err =>
      log.error({ err: err.message }, 'Failed to subscribe to game events'))

    this.subscriber.on('pmessage', (pattern, channel, raw) => {
      if (pattern !== 'game:event:*') return
      const msg = parseMessage(raw)
      if (!msg || msg.type !== 'event') return

      for (const [socket, meta] of this.connections.entries()) {
        if (meta.sessionId === msg.sessionId) {
          try { socket.send(raw) } catch (err) {
            log.error({ err: err.message, sessionId: msg.sessionId }, 'Failed to forward WS event')
          }
        }
      }
    })
  }
}
