// public/websocket-client.js
// TASK-C9.1 — WebSocket Client
//
// Features:
//   - Send queue: buffers messages sent while disconnected
//   - Exponential backoff reconnect: 1s → 2s → 4s … → 30s cap
//   - Heartbeat: ping every 15s, server must respond (pong via JSON {type:'pong'})
//   - Status callbacks: onOpen, onClose, onError, onMessage
//
// Usage:
//   const ws = new ArcadeWsClient(url, { onOpen, onClose, onError, onMessage })
//   ws.send({ action: 'btn_A', state: 'pressed' })
//   ws.destroy()

const HEARTBEAT_INTERVAL_MS = 15_000
const RECONNECT_MIN_MS      = 1_000
const RECONNECT_MAX_MS      = 30_000

export class ArcadeWsClient {
  /**
   * @param {string} url  WebSocket URL, e.g. ws://host/ws/game?sessionId=X&playerId=Y
   * @param {{
   *   onOpen?:    () => void,
   *   onClose?:   (code: number, reason: string) => void,
   *   onError?:   (err: Event) => void,
   *   onMessage?: (data: object) => void,
   * }} handlers
   */
  constructor(url, handlers = {}) {
    this.url      = url
    this.handlers = handlers

    /** @type {string[]} Messages buffered while disconnected */
    this._queue      = []
    this._reconnectMs = RECONNECT_MIN_MS
    this._reconnectTimer = null
    this._heartbeatTimer = null
    this._destroyed  = false
    this._ws         = null

    this._connect()
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Sends a game input object.
   * If the socket is not open, the message is queued and sent on reconnect.
   * @param {{ action: string, state: 'pressed'|'released' }} payload
   */
  send(payload) {
    const msg = JSON.stringify(payload)
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(msg)
    } else {
      // Cap the queue at 32 to avoid unbounded memory growth
      if (this._queue.length < 32) this._queue.push(msg)
    }
  }

  /** Returns true if the socket is currently open */
  get connected() {
    return this._ws?.readyState === WebSocket.OPEN
  }

  /** Permanently closes the connection. No reconnect will happen. */
  destroy() {
    this._destroyed = true
    clearTimeout(this._reconnectTimer)
    clearInterval(this._heartbeatTimer)
    this._ws?.close(1000, 'client destroyed')
    this._ws = null
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _connect() {
    if (this._destroyed) return

    this._ws = new WebSocket(this.url)

    this._ws.addEventListener('open', () => {
      this._reconnectMs = RECONNECT_MIN_MS  // reset backoff on success

      // Flush queued messages
      while (this._queue.length) {
        this._ws.send(this._queue.shift())
      }

      this._startHeartbeat()
      this.handlers.onOpen?.()
    })

    this._ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'pong') return  // heartbeat reply — ignore
        this.handlers.onMessage?.(data)
      } catch { /* ignore malformed messages */ }
    })

    this._ws.addEventListener('close', (event) => {
      this._stopHeartbeat()
      this.handlers.onClose?.(event.code, event.reason)
      if (!this._destroyed) this._scheduleReconnect()
    })

    this._ws.addEventListener('error', (event) => {
      this.handlers.onError?.(event)
    })
  }

  _scheduleReconnect() {
    this._reconnectTimer = setTimeout(() => {
      this._connect()
      // Exponential backoff capped at RECONNECT_MAX_MS
      this._reconnectMs = Math.min(this._reconnectMs * 2, RECONNECT_MAX_MS)
    }, this._reconnectMs)
  }

  _startHeartbeat() {
    this._stopHeartbeat()
    this._heartbeatTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer)
    this._heartbeatTimer = null
  }
}
