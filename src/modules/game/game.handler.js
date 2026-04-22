// src/modules/game/game.handler.js
// Core WebSocket logic for the Street Arcade game server.
//
// Responsibilities:
//   1. Validate the session on connect (Redis cache → MongoDB fallback)
//   2. Map each socket to { sessionId, playerId }
//   3. Forward player inputs to Redis Pub/Sub (game:input:{sessionId})
//   4. Publish lifecycle events (player_connected, player_disconnected)
//   5. Heartbeat: detect zombie clients via ping/pong (30s interval, 30s timeout)
//
// Data flow:
//   Socket → onMessage → buildMessage → redisPublisher.publish → UDP dispatcher (Phase 5)

import { Channels, buildMessage, parseMessage } from '../../lib/channels.js'
import { SessionCache } from '../session/session.cache.js'
import { SessionRepository } from '../session/session.repository.js'
import { createLogger } from '../../lib/logger.js'
import { env } from '../../config/env.js'

const log = createLogger('game.handler')

// ── Constants ────────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 15_000   // send ping every 15s
const HEARTBEAT_TIMEOUT_MS  = 30_000   // disconnect if no pong in 30s

/**
 * GameHandler manages all active WebSocket connections.
 * One instance is shared across the entire server lifetime.
 */
export class GameHandler {
  constructor(fastify) {
    this.fastify    = fastify                // needed for udpDispatcher (set in onReady)
    this.publisher  = fastify.redisPublisher
    this.subscriber = fastify.redisSubscriber
    this.cache      = fastify.mongo ? new SessionCache(fastify.redisPublisher) : null
    this.repo       = fastify.mongo ? new SessionRepository(fastify.mongo) : null

    /** @type {Map<WebSocket, { sessionId: string, playerId: string, alive: boolean }>} */
    this.connections = new Map()

    this._startHeartbeat()
    this._setupSubscriptions()
  }

  // ── Public: called from game.routes.js ─────────────────────────────────────

  /**
   * Handles a new WebSocket connection.
   * Expected query params: ?sessionId=X&playerId=Y
   */
  async onConnect(socket, request) {
    const { sessionId, playerId } = request.query

    if (!sessionId || !playerId) {
      socket.close(1008, 'Missing sessionId or playerId')
      return
    }

    // Validate session — Redis first, MongoDB fallback
    const session = await this._findSession(sessionId)

    if (!session) {
      socket.close(1008, `Session not found: ${sessionId}`)
      return
    }

    if (session.status === 'finished') {
      socket.close(1008, 'Session already finished')
      return
    }

    // If session has specific reserved/allowed players, enforce it
    const allowed = session.allowedPlayers || []
    if (allowed.length > 0 && !allowed.includes(playerId)) {
      socket.close(1008, 'You are not allowed in this session')
      return
    }

    const playerCount = (session.players ?? []).length
    if (playerCount >= session.maxPlayers) {
      socket.close(1008, 'Session is full')
      return
    }

    // Register connection
    this.connections.set(socket, { sessionId, playerId, alive: true })
    log.info({ sessionId, playerId, total: this.connections.size }, 'Player connected')

    // Register socket handlers IMMEDIATELY — before any await.
    // If registered after awaits, messages sent in quick succession are lost.
    socket.on('message', (raw) => this.onMessage(socket, raw))
    socket.on('close',   ()    => this.onClose(socket))
    socket.on('pong',    ()    => this._markAlive(socket))
    socket.on('error',   (err) => log.error({ err: err.message, sessionId, playerId }, 'WS error'))

    // Persist player in MongoDB + refresh Redis cache (non-blocking for input flow)
    if (this.repo) {
      await this.repo.addPlayer(sessionId, playerId)
    }
    if (this.cache) {
      const updated = this.repo ? await this.repo.findById(sessionId) : await this._findSession(sessionId)
      if (updated) {
        // If we don't have repo, we must forcefully update the cached array/status here (though without mongo, state memory relies on cache)
        if (!this.repo) {
          updated.status = 'active'
          updated.players = updated.players || []
          updated.players.push({ id: playerId, connectedAt: new Date() })
        }
        await this.cache.set(this._normalizeSession(updated))
      }
    }

    // TASK-U5.4: register session totems in UDP dispatcher so packets are routed correctly
    const dispatcher = this.fastify.udpDispatcher  // available after onReady
    if (dispatcher && session.totems?.length) {
      dispatcher.registerSession(sessionId, session.totems)
    }

    // Publish lifecycle event
    await this._publish(Channels.sessionSync(sessionId), 'sync', sessionId, playerId, {
      event: 'player_connected',
      playerId,
    })
  }

  /**
   * Handles an incoming message from a connected client.
   * Expected format: JSON { action: string, state: 'pressed'|'released' }
   */
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

    // Refresh TTL on both Redis and MongoDB so active sessions don't expire
    if (this.cache) await this.cache.refreshTtl(sessionId, env.sessionTimeoutMs)
    if (this.repo)  await this.repo.refreshTtl(sessionId, env.sessionTimeoutMs)

    // Publish to Redis — UDP dispatcher (Phase 5) will pick this up
    await this._publish(Channels.gameInput(sessionId), 'input', sessionId, playerId, {
      action,
      state,
    })

    log.debug({ sessionId, playerId, action, state }, 'Input forwarded')
  }

  /**
   * Handles socket close — removes the connection and notifies other players.
   */
  async onClose(socket) {
    const meta = this.connections.get(socket)
    if (!meta) return

    const { sessionId, playerId } = meta
    this.connections.delete(socket)

    log.info({ sessionId, playerId, remaining: this.connections.size }, 'Player disconnected')

    // Remove from MongoDB and update cache
    if (this.repo) {
      await this.repo.removePlayer(sessionId, playerId)
      const updated = await this.repo.findById(sessionId)
      if (updated) {
        // If no players are left and it was active, revert to waiting
        const remaining = (updated.players ?? [])
        if (remaining.length === 0 && updated.status === 'active') {
          await this.repo.updateStatus(sessionId, 'waiting')
          updated.status = 'waiting'
        }
        if (this.cache) await this.cache.set(this._normalizeSession(updated))
      }
    } else if (this.cache) {
      const cached = await this.cache.get(sessionId)
      if (cached) {
        cached.players = (cached.players ?? []).filter(p => p.id !== playerId)
        if (cached.players.length === 0 && cached.status === 'active') {
          cached.status = 'waiting'
        }
        await this.cache.set(cached)
      }
    }

    // Publish lifecycle event
    await this._publish(Channels.sessionSync(sessionId), 'sync', sessionId, playerId, {
      event: 'player_disconnected',
      playerId,
    })
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** Looks up session: Redis cache first, MongoDB fallback */
  async _findSession(sessionId) {
    if (this.cache) {
      const cached = await this.cache.get(sessionId)
      if (cached) return cached
    }
    if (this.repo) {
      return this.repo.findById(sessionId)
    }
    return null
  }

  /** Normalizes a Mongo document to the shape SessionCache.set() expects */
  _normalizeSession(doc) {
    return {
      _id:        doc._id ?? doc.id,
      status:     doc.status,
      maxPlayers: doc.maxPlayers,
      totems:     doc.totems ?? [],
      players:    doc.players ?? [],
      expiresAt:  doc.expiresAt,
    }
  }

  /** Publishes a typed message to a Redis channel */
  async _publish(channel, type, sessionId, playerId, data) {
    try {
      await this.publisher.publish(channel, buildMessage(type, sessionId, playerId, data))
    } catch (err) {
      log.error({ err: err.message, channel }, 'Redis publish failed')
    }
  }

  /** Marks the socket as alive when a pong is received */
  _markAlive(socket) {
    const meta = this.connections.get(socket)
    if (meta) meta.alive = true
  }

  /**
   * Sends ping to all sockets every HEARTBEAT_INTERVAL_MS.
   * Disconnects any socket that didn't reply within HEARTBEAT_TIMEOUT_MS.
   */
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

  /**
   * Subscribes to Redis events to broadcast them to WebSockets.
   */
  _setupSubscriptions() {
    if (!this.subscriber) return

    this.subscriber.psubscribe('game:event:*').catch(err => 
      log.error({ err: err.message }, 'Failed to subscribe to game events')
    )

    this.subscriber.on('pmessage', (pattern, channel, raw) => {
      if (pattern !== 'game:event:*') return
      
      const msg = parseMessage(raw)
      if (!msg || msg.type !== 'event') return

      const { sessionId } = msg
      let sentCount = 0

      // Broadcast to all sockets belonging to this session
      for (const [socket, meta] of this.connections.entries()) {
        if (meta.sessionId === sessionId) {
          try {
            socket.send(raw)
            sentCount++
          } catch (err) {
            log.error({ err: err.message, sessionId, playerId: meta.playerId }, 'Failed to forward WS event')
          }
        }
      }

      log.debug({ sessionId, sentCount, event: msg.data?.event }, 'Broadcasted event to clients')
    })
  }
}
