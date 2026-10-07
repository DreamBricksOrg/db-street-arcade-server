// src/modules/game/game.output.js
// The ONE place that delivers a packet to the game a session belongs to:
//   instance 'default' → UDP datagram to the physical totem (session.totems)
//   any other instance → SSE stream of that iframe (InstanceHub)
// Callers: GameHandler (player_join), TotemQueueService (player_leave),
// UdpDispatcher (inputs).
//
// With Redis, iframe packets go through the `inst:out:{instanceKey}` channel:
// the SSE stream may live on ANOTHER backend process (the one the iframe
// connected to), and InstanceHub.listen() delivers it there.

import { isDefaultInstance, instanceKey } from '../../lib/channels.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('game.output')

export class GameOutput {
  /**
   * @param {{ udpSend?: (ip: string, port: number, msg: string) => Promise<void>,
   *           hub: import('../instance/instance.hub.js').InstanceHub,
   *           publish?: (channel: string, msg: string) => Promise<unknown> }} deps
   */
  constructor({ udpSend, hub, publish }) {
    this._udpSend = udpSend ?? null
    this._hub     = hub
    this._publish = publish ?? null
  }

  /**
   * @param {{ totemId?: string, instanceId?: string, totems?: Array<{ip, udpPort}> }} session
   * @param {object} packet  compact game packet ({ sid, pid, a, s, ts } or { type, sid, pid, tid })
   */
  async send(session, packet) {
    if (!isDefaultInstance(session.instanceId)) {
      if (this._publish) {
        await this._publish(`inst:out:${instanceKey(session.totemId, session.instanceId)}`, JSON.stringify(packet))
      } else {
        this._hub.push(session.totemId, session.instanceId, packet)
      }
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
