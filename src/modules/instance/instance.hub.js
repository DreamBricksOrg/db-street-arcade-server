// src/modules/instance/instance.hub.js
// Open SSE streams of embedded game iframes HELD BY THIS PROCESS, keyed by
// instance (multi-process delivery: see listen()). This is the
// web equivalent of the UDP socket a physical totem listens on: packets are
// written in the exact shape games/*/server.js forwards today, so the games
// run unchanged under /embed/:totemId/:instanceId/.

import { instanceKey } from '../../lib/channels.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('instance.hub')

const PING_MS = 15_000

export class InstanceHub {
  constructor() {
    /** instanceKey → Set<http.ServerResponse> */
    this._streams = new Map()
    this._ping = setInterval(() => this._broadcastRaw(': ping\n\n'), PING_MS)
    this._ping.unref?.()
  }

  add(totemId, instanceId, res) {
    const k = instanceKey(totemId, instanceId)
    if (!this._streams.has(k)) this._streams.set(k, new Set())
    this._streams.get(k).add(res)
  }

  remove(totemId, instanceId, res) {
    const k = instanceKey(totemId, instanceId)
    const set = this._streams.get(k)
    if (!set) return
    set.delete(res)
    if (!set.size) this._streams.delete(k)
  }

  count(totemId, instanceId) {
    return this._streams.get(instanceKey(totemId, instanceId))?.size ?? 0
  }

  /** @returns {number} how many streams received the packet */
  push(totemId, instanceId, packet) {
    return this._pushKey(instanceKey(totemId, instanceId), packet)
  }

  /**
   * Cross-process delivery: GameOutput publishes iframe packets on
   * `inst:out:{instanceKey}`; every process forwards them to the streams it
   * holds (usually exactly one process has the iframe's stream).
   */
  async listen(subscriber) {
    subscriber.on('pmessage', (pattern, channel, raw) => {
      if (pattern !== 'inst:out:*') return
      this._pushKey(channel.slice('inst:out:'.length), raw, { quiet: true })
    })
    await subscriber.psubscribe('inst:out:*')
  }

  _pushKey(k, packet, { quiet = false } = {}) {
    const set = this._streams.get(k)
    if (!set?.size) {
      if (!quiet) log.debug({ instance: k }, 'No open stream for instance — packet dropped')
      return 0
    }
    const msg = `data: ${typeof packet === 'string' ? packet : JSON.stringify(packet)}\n\n`
    let sent = 0
    for (const res of set) {
      try { res.write(msg); sent++ } catch { /* stream gone; close handler cleans up */ }
    }
    return sent
  }

  /** Ends every stream of an instance (totem deleted / instance dropped). */
  closeInstance(totemId, instanceId) {
    const k = instanceKey(totemId, instanceId)
    for (const res of this._streams.get(k) ?? []) {
      try { res.end() } catch { /* already closed */ }
    }
    this._streams.delete(k)
  }

  close() {
    clearInterval(this._ping)
    for (const set of this._streams.values()) {
      for (const res of set) { try { res.end() } catch { /* closed */ } }
    }
    this._streams.clear()
  }

  _broadcastRaw(raw) {
    for (const set of this._streams.values()) {
      for (const res of set) { try { res.write(raw) } catch { /* gone */ } }
    }
  }
}
