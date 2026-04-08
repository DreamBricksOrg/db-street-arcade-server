// src/plugins/udp.js
// TASK-U5.1 — Módulo UDP Sender
//
// Creates a single shared UDP socket for the lifetime of the server.
// Decorates: fastify.udpSend(ip, port, message)
//
// WHY one socket for all totems?
// dgram.send() accepts a destination on each call — no separate socket per totem.
// Send-only sockets need no bind(); the OS assigns an ephemeral source port on first send.

import dgram from 'node:dgram'
import fp    from 'fastify-plugin'
import { createLogger } from '../lib/logger.js'

const log = createLogger('udp')

async function udpPlugin(fastify) {
  const socket = dgram.createSocket('udp4')

  socket.on('error', (err) => {
    log.error({ err: err.message }, 'UDP socket error')
  })

  /**
   * Send a message string to a UDP endpoint.
   * @param {string} ip
   * @param {number} port
   * @param {string} message  — serialized string, must be < 512 bytes
   * @returns {Promise<void>}
   */
  function udpSend(ip, port, message) {
    const buf = Buffer.from(message, 'utf8')
    return new Promise((resolve, reject) => {
      socket.send(buf, 0, buf.length, port, ip, (err) => {
        if (err) {
          log.warn({ err: err.message, ip, port }, 'UDP send failed')
          return reject(err)
        }
        log.debug({ ip, port, bytes: buf.length }, 'UDP packet sent')
        resolve()
      })
    })
  }

  // Expose as fastify.udpSend(ip, port, message)
  fastify.decorate('udpSend', udpSend)

  log.info('UDP socket ready (send-only)')

  // Graceful shutdown
  fastify.addHook('onClose', (_instance, done) => {
    socket.close(done)
    log.debug('UDP socket closed')
  })
}

export default fp(udpPlugin, {
  name: 'udp',
})
