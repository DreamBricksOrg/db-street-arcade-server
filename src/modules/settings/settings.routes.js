// src/modules/settings/settings.routes.js
// Editable settings stored in MongoDB (`settings` collection, one doc per key).
//
//   GET /api/settings/nicknames   → { animals, adjectives, isDefault }
//   PUT /api/settings/nicknames   { animals, adjectives } (operator)
//
// fastify.settings.nicknameLists() is read on every queue join, so it keeps a
// short in-process cache (other processes pick up edits within CACHE_MS).

import fp from 'fastify-plugin'
import { DEFAULT_ANIMALS, DEFAULT_ADJECTIVES, cleanList, drawNickname, MAX_ITEMS } from '../../lib/nicknames.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('settings')
const CACHE_MS = 15_000

async function settingsRoutes(fastify) {
  const col = fastify.mongo ? fastify.mongo.client.db().collection('settings') : null
  let cache = null, cachedAt = 0

  async function nicknameLists() {
    if (cache && Date.now() - cachedAt < CACHE_MS) return cache
    const doc = col ? await col.findOne({ _id: 'nicknames' }).catch(() => null) : null
    cache = {
      animals:    doc?.animals?.length ? doc.animals : DEFAULT_ANIMALS,
      adjectives: doc?.adjectives?.length ? doc.adjectives : DEFAULT_ADJECTIVES,
      isDefault:  !doc,
      updatedAt:  doc?.updatedAt ?? null,
      updatedBy:  doc?.updatedBy ?? null,
    }
    cachedAt = Date.now()
    return cache
  }

  fastify.decorate('settings', { nicknameLists })

  if (!col) return

  const listSchema = { type: 'array', maxItems: MAX_ITEMS, items: { type: 'string', maxLength: 64 } }

  fastify.get('/api/settings/nicknames', {
    config: { operator: true },
    schema: { tags: ['Settings'], summary: 'Animal and adjective lists used for anonymous player names' },
  }, async () => {
    const lists = await nicknameLists()
    const examples = Array.from({ length: 6 }, () => drawNickname(lists))
    return { ...lists, examples }
  })

  fastify.put('/api/settings/nicknames', {
    config: { operator: true, role: 'admin', audit: 'settings.nicknames' },
    schema: {
      tags: ['Settings'], summary: 'Replace the nickname lists (admin)',
      body: {
        type: 'object',
        properties: { animals: listSchema, adjectives: listSchema, reset: { type: 'boolean' } },
      },
    },
  }, async (request, reply) => {
    if (request.body?.reset) {
      await col.deleteOne({ _id: 'nicknames' })
      cache = null
      return { ok: true, ...(await nicknameLists()) }
    }
    const animals = cleanList(request.body?.animals)
    const adjectives = cleanList(request.body?.adjectives)
    if (!animals || !adjectives) return reply.status(400).send({ error: 'As duas listas precisam ter pelo menos um item.' })
    await col.updateOne(
      { _id: 'nicknames' },
      { $set: { animals, adjectives, updatedAt: new Date(), updatedBy: request.operator?.username ?? null } },
      { upsert: true },
    )
    cache = null
    log.info({ animals: animals.length, adjectives: adjectives.length }, 'Nickname lists updated')
    return { ok: true, ...(await nicknameLists()) }
  })
}

export default fp(settingsRoutes, { name: 'settings-routes' })
