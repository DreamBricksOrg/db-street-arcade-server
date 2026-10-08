// tests/unit/nicknames.test.mjs — anonymous animal names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drawNickname, cleanList, DEFAULT_ANIMALS, DEFAULT_ADJECTIVES } from '../../src/lib/nicknames.js'

test('sorteia "Animal Adjetivo" das listas', () => {
  const name = drawNickname({ animals: ['Capivara'], adjectives: ['Veloz'] })
  assert.equal(name, 'Capivara Veloz')
  assert.match(drawNickname({}), /^\S+(-\S+)? \S+$/, 'listas vazias usam as padrão')
})

test('evita nomes em uso e numera quando não há saída', () => {
  const lists = { animals: ['Capivara', 'Tatu'], adjectives: ['Veloz'] }
  const draws = [0, 0, 0.9, 0]   // 1st: Capivara Veloz (taken) → 2nd: Tatu Veloz
  let i = 0
  const seq = () => draws[i++ % draws.length]
  assert.equal(drawNickname(lists, new Set(['Capivara Veloz']), seq), 'Tatu Veloz')
  const full = drawNickname({ animals: ['Capivara'], adjectives: ['Veloz'] }, ['Capivara Veloz', 'Capivara Veloz 2'])
  assert.equal(full, 'Capivara Veloz 3')
})

test('limpa listas editadas: espaços, vazios, repetidos (sem diferenciar maiúsculas)', () => {
  assert.deepEqual(cleanList(['  Pato ', '', 'pato', 'Lontra  Marinha', null]), ['Pato', 'Lontra Marinha'])
  assert.equal(cleanList([' ', '']), null)
  assert.equal(cleanList('nada'), null)
})

test('adjetivos padrão servem para os dois gêneros (sem -o/-a no fim)', () => {
  const invariable = new Set(['Tagarela', 'Turbo'])   // end in -a/-o but fit both genders
  for (const adj of DEFAULT_ADJECTIVES) if (!invariable.has(adj)) assert.doesNotMatch(adj, /[oa]$/i, adj)
  assert.ok(DEFAULT_ANIMALS.length >= 20)
})
