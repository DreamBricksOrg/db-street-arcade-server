#!/usr/bin/env node
// scripts/check-env.mjs — is this .env ready for production?
//   npm run ops:check-env                 (reads ./.env)
//   npm run ops:check-env -- path/to/.env
// Exit code 1 when there are errors (usable in a deploy script).

import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { checkProductionEnv } from '../src/lib/envCheck.js'

const file = path.resolve(process.argv[2] ?? '.env')
if (!fs.existsSync(file)) {
  console.error(`Arquivo não encontrado: ${file}`)
  process.exit(1)
}

const parsed = dotenv.parse(fs.readFileSync(file))
const { errors, warnings } = checkProductionEnv(parsed)

console.log(`Verificando ${file}\n`)
for (const m of errors) console.log(`  ERRO   ${m}`)
for (const m of warnings) console.log(`  AVISO  ${m}`)
if (!errors.length && !warnings.length) console.log('  Tudo certo para produção.')
console.log(`\n${errors.length} erro(s), ${warnings.length} aviso(s).`)
process.exit(errors.length ? 1 : 0)
