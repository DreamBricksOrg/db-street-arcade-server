// src/lib/inputs.js
// What a phone may send over /ws/game, and how fast — pure, clock injectable.
//
// The gamepad (public/gamepad.js) only ever sends these 8 actions with
// 'pressed' | 'released'. Anything else is a modified client and is dropped
// before it reaches Redis, the UDP socket or an iframe's SSE stream.

export const ACTIONS = new Set([
  'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
  'btn_A', 'btn_B', 'btn_X', 'btn_Y',
])
export const STATES = new Set(['pressed', 'released'])

/**
 * @returns {{ kind: 'input', action, state } | { kind: 'ping' } | { kind: 'invalid', reason }}
 */
export function classifyMessage(raw) {
  let msg
  try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()) } catch { return { kind: 'invalid', reason: 'not JSON' } }
  if (!msg || typeof msg !== 'object') return { kind: 'invalid', reason: 'not an object' }
  if (msg.type === 'ping') return { kind: 'ping' }
  if (!ACTIONS.has(msg.action)) return { kind: 'invalid', reason: 'unknown action' }
  if (!STATES.has(msg.state)) return { kind: 'invalid', reason: 'unknown state' }
  return { kind: 'input', action: msg.action, state: msg.state }
}

/**
 * Token bucket: `ratePerSec` sustained, bursts up to `burst`. A frantic
 * button masher stays well under 30/s; a script does not.
 */
export function createTokenBucket({ ratePerSec = 30, burst = 40, now = Date.now } = {}) {
  let tokens = burst
  let last = now()
  return function take() {
    const t = now()
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * ratePerSec)
    last = t
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}
