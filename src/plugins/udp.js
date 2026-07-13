// src/plugins/udp.js
// TASK-U5.1 — Módulo UDP Sender
//
// Creates a single shared UDP socket for the lifetime of the server.
// Decorates: fastify.udpSend(ip, port, message)
//
// WHY one socket for all totems?
// dgram.send() accepts a destination on each call — no separate socket per totem.
// Send-only sockets need no bind(); the OS assigns an ephemeral source port on first send.
//
// Totems can now be registered with a hostname (e.g. brickrush.dbpe.com.br)
// instead of a raw IP. dgram.send() DOES resolve hostnames itself, but it
// does a fresh DNS lookup on EVERY call — a gamepad button press/release
// fires one UDP packet each, so that would mean a DNS query per keystroke.
// We resolve+cache the IP ourselves (short TTL) so only the first packet
// after the cache expires pays the lookup cost; literal IPs skip this
// entirely (isIP() short-circuits).

import dgram from 'node:dgram'
import dns   from 'node:dns/promises'
import { isIP } from 'node:net'
import fp    from 'fastify-plugin'
import { createLogger } from '../lib/logger.js'

const log = createLogger('udp')

const DNS_CACHE_TTL_MS = 30_000

async function udpPlugin(fastify) {
  const socket = dgram.createSocket('udp4')
  const dnsCache = new Map() // hostname -> { ip, expiresAt }

  socket.on('error', (err) => {
    log.error({ err: err.message }, 'UDP socket error')
  })

  /** Resolves a hostname to an IP, cached for DNS_CACHE_TTL_MS. IPs pass through untouched. */
  async function resolveHost(host) {
    if (isIP(host)) return host

    const cached = dnsCache.get(host)
    if (cached && cached.expiresAt > Date.now()) return cached.ip

    const { address } = await dns.lookup(host, { family: 4 })
    dnsCache.set(host, { ip: address, expiresAt: Date.now() + DNS_CACHE_TTL_MS })
    return address
  }

  /**
   * Send a message string to a UDP endpoint.
   * @param {string} ip  IP address or hostname
   * @param {number} port
   * @param {string} message  — serialized string, must be < 512 bytes
   * @returns {Promise<void>}
   */
  async function udpSend(ip, port, message) {
    const buf = Buffer.from(message, 'utf8')

    let address
    try {
      address = await resolveHost(ip)
    } catch (err) {
      log.warn({ err: err.message, ip, port }, 'UDP DNS resolution failed')
      throw err
    }

    return new Promise((resolve, reject) => {
      socket.send(buf, 0, buf.length, port, address, (err) => {
        if (err) {
          log.warn({ err: err.message, ip, address, port }, 'UDP send failed')
          return reject(err)
        }
        log.debug({ ip, address, port, bytes: buf.length }, 'UDP packet sent')
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
