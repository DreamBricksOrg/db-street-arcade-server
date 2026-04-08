// src/lib/channels.js
// Redis channel naming convention and message format for the Street Arcade system.
// Import this wherever you need to publish or subscribe to a channel.

/**
 * Channel names for Redis Pub/Sub.
 * All channels are scoped by sessionId to avoid cross-session interference.
 */
export const Channels = {
  /** Player button inputs — subscribed by UDP dispatcher */
  gameInput:  (sessionId) => `game:input:${sessionId}`,

  /** Server-side events (start, stop, timeout) — subscribed by frontend WS */
  gameEvent:  (sessionId) => `game:event:${sessionId}`,

  /** Session state sync (player joined, left, status change) */
  sessionSync: (sessionId) => `session:sync:${sessionId}`,
}

/**
 * Redis HASH key for caching session state.
 * @param {string} sessionId
 */
export const SessionKey = (sessionId) => `session:${sessionId}`

/**
 * Builds a typed Redis message payload.
 *
 * @param {'input'|'event'|'sync'} type
 * @param {string} sessionId
 * @param {string|null} playerId
 * @param {object} data
 * @returns {string} JSON-serialized message
 *
 * @example
 * buildMessage('input', sid, pid, { action: 'btn_A', state: 'pressed' })
 */
export function buildMessage(type, sessionId, playerId, data) {
  return JSON.stringify({
    type,
    sessionId,
    playerId,
    data,
    ts: Date.now(),
  })
}

/**
 * Parses a Redis Pub/Sub message string back into an object.
 * Returns null if the message is malformed.
 * @param {string} raw
 */
export function parseMessage(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
