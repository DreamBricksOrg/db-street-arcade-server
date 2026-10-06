// src/modules/game/game.output.js
// The ONE place that delivers a packet to the game a session belongs to:
//   instance 'default' → UDP datagram to the physical totem (session.totems)
//   any other instance → SSE stream of that iframe (InstanceHub)
// Callers: GameHandler (player_join), TotemQueueService (player_leave),
// UdpDispatcher (inputs).

import { isDefaultInstance } from '../../lib/channels.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('game.output')

export class GameOutput {
  /**
   * @param {{ udpSend?: (ip: string, port: number, msg: string) => Promise<void>,
   *           hub: import('../instance/instance.hub.js').InstanceHub }} deps
   */
  constructor({ udpSend, hub }) {
    this._udpSend = udpSend ?? null
    this._hub     = hub
  }

  /**
   * @param {{ totemId?: string, instanceId?: string, totems?: Array<{ip, udpPort}> }} session
   * @param {object} packet  compact game packet ({ sid, pid, a, s, ts } or { type, sid, pid, tid })
   */
  async send(session, packet) {
    if (!isDefaultInstance(session.instanceId)) {
      this._hub.push(session.totemId, session.instanceId, packet)
      return
    }

    if (!this._udpSend) return
    const msg = JSON.stringify(packet)
    await Promise.allSettled((session.totems ?? [])
      .filter(t => t?.ip && t?.udpPort)
      .map(({ ip, udpPort }) => this._udpSend(ip, udpPort, msg).catch(err =>
        log.warn({ ip, udpPort, err: err.message }, 'UDP send error'))))
  }
}
