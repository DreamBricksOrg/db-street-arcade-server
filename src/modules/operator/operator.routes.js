// src/modules/operator/operator.routes.js
// One live stream for the operator dashboard (replaces one poll per card).
//
//   GET /api/operator/events  (operator, SSE)
//     → { type:'state', totems: { [totemId]: rows } }   on connect / reconnect
//     → { type:'totem', totemId, rows }                 when that totem changes
//     → { type:'totems_changed' }                       a totem was created/edited/deleted
//   rows = the same shape as GET /api/totems/:id/instances
//
// Change signals:
//   queue:event:{totemId}[:{instanceId}]  — already published by the queue
//     service on join/leave/advance/claim/end/clear (all processes)
//   ops:totem:{totemId} / ops:totems      — fastify.opsNotify(): iframe opened
//     or closed, totem CRUD
// Signals are debounced per totem, then the rows are recomputed once.

import { EventEmitter } from 'node:events'
import fp from 'fastify-plugin'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('operator.routes')

const DEBOUNCE_MS = 250
const PING_MS     = 20_000

async function operatorRoutes(fastify) {
  if (!fastify.totemQueue) {
    log.warn('Queue service not available — operator stream disabled')
    return
  }

  const local = new EventEmitter()   // in-process fan-out (and the only path without Redis)
  local.setMaxListeners(0)
  const pub = fastify.redisPublisher ?? null

  /** Something about `totemId` changed (null = the totem list itself). */
  function opsNotify(totemId = null) {
    const channel = totemId ? `ops:totem:${totemId}` : 'ops:totems'
    if (pub) pub.publish(channel, '1').catch(() => local.emit('signal', totemId))
    else local.emit('signal', totemId)
  }
  fastify.decorate('opsNotify', opsNotify)

  if (fastify.redisSubscriber) {
    fastify.redisSubscriber.on('pmessage', (pattern, channel) => {
      if (pattern === 'queue:event:*') local.emit('signal', channel.slice('queue:event:'.length).split(':')[0])
      else if (pattern === 'ops:*') local.emit('signal', channel === 'ops:totems' ? null : channel.slice('ops:totem:'.length))
    })
    await fastify.redisSubscriber.psubscribe('ops:*')
    // queue:event:* is already subscribed by the totem routes (same client).
  }

  async function rowsOf(totemId) {
    const instances = fastify.instances
    const queue = fastify.totemQueue
    const list = [{ id: 'default', online: null, createdAt: null }, ...(await instances.list(totemId))]
    return Promise.all(list.map(async (r) => ({ ...r, ...(await queue.instanceCounts(totemId, r.id)) })))
  }

  const streams = new Set()
  const pending = new Map()   // totemId|null → timer

  function broadcast(obj) {
    const msg = `data: ${JSON.stringify(obj)}\n\n`
    for (const res of streams) { try { res.write(msg) } catch { /* gone */ } }
  }

  local.on('signal', (totemId) => {
    if (!streams.size || pending.has(totemId)) return
    pending.set(totemId, setTimeout(async () => {
      pending.delete(totemId)
      try {
        if (!totemId) return broadcast({ type: 'totems_changed' })
        const totem = await fastify.totemService.findTotem(totemId)
        if (!totem) return broadcast({ type: 'totems_changed' })
        broadcast({ type: 'totem', totemId, rows: await rowsOf(totemId) })
      } catch (err) {
        log.warn({ err: err.message, totemId }, 'Operator stream update failed')
      }
    }, DEBOUNCE_MS))
  })

  const ping = setInterval(() => {
    for (const res of streams) { try { res.write(': ping\n\n') } catch { /* gone */ } }
  }, PING_MS)
  ping.unref?.()
  fastify.addHook('onClose', async () => {
    clearInterval(ping)
    for (const t of pending.values()) clearTimeout(t)
    for (const res of streams) { try { res.end() } catch { /* closed */ } }
  })

  fastify.get('/api/operator/events', {
    config: { operator: true },
    schema: { tags: ['Operator'], summary: 'Live dashboard stream (SSE): per-totem sessions, queue and open screens' },
  }, async (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const totems = await fastify.totemService.listTotems()
    const state = {}
    for (const t of totems) state[t._id] = await rowsOf(t._id).catch(() => null)
    reply.raw.write(`data: ${JSON.stringify({ type: 'state', totems: state })}\n\n`)

    streams.add(reply.raw)
    request.raw.on('close', () => streams.delete(reply.raw))
  })
}

export default fp(operatorRoutes, { name: 'operator-routes' })
