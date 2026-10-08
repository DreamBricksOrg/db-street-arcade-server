#!/usr/bin/env node
// scripts/totem-keys.mjs — totems without a game key (created before keys
// existed). While a totem has no key, anyone with its id (it is in the QR)
// can end a player's game via POST /api/totems/:id/end-session.
//
//   npm run ops:totem-keys            list them (changes nothing)
//   npm run ops:totem-keys -- --apply generate a key for each one and print
//                                     the TOTEM_ID / TOTEM_KEY lines to put in
//                                     that cabinet's games/<game>/.env
//
// After --apply, a cabinet only reports deaths again once its bridge .env has
// the new TOTEM_KEY — do it right before updating the machines.
// Uses MONGO_URI from ./.env (or the environment).

import 'dotenv/config'
import { MongoClient } from 'mongodb'
import { newTotemKey } from '../src/lib/auth.js'

const apply = process.argv.includes('--apply')
const uri = process.env.MONGO_URI
if (!uri) {
  console.error('MONGO_URI não definido (.env ou ambiente).')
  process.exit(1)
}

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
try {
  await client.connect()
  const col = client.db().collection('totems')
  const missing = await col.find(
    { $or: [{ gameKey: { $exists: false } }, { gameKey: null }, { gameKey: '' }] },
    { projection: { name: 1, ip: 1, udpPort: 1, game: 1 } },
  ).sort({ name: 1 }).toArray()

  const safeUri = uri.replace(/\/\/[^@/]*@/, '//***@')
  console.log(`Banco: ${safeUri}`)
  if (!missing.length) {
    console.log('Todos os totens já têm chave.')
    process.exit(0)
  }

  console.log(`${missing.length} totem(ns) sem chave:\n`)
  for (const t of missing) {
    const where = t.ip ? `físico ${t.ip}:${t.udpPort}` : 'só web'
    console.log(`  ${t._id}  ${t.name}  (${where}${t.game ? `, jogo ${t.game}` : ''})`)
  }

  if (!apply) {
    console.log('\nNada foi alterado. Rode com --apply para gerar as chaves.')
    process.exit(0)
  }

  console.log('\nChaves geradas — copie para o .env da ponte de cada máquina:\n')
  for (const t of missing) {
    const gameKey = newTotemKey()
    await col.updateOne({ _id: t._id }, { $set: { gameKey, updatedAt: new Date() } })
    console.log(`# ${t.name}${t.game ? ` → games/${t.game}/.env` : ''}`)
    console.log(`TOTEM_ID=${t._id}`)
    console.log(`TOTEM_KEY=${gameKey}\n`)
  }
} catch (err) {
  console.error(`Falhou: ${err.message}`)
  process.exitCode = 1
} finally {
  await client.close()
}
