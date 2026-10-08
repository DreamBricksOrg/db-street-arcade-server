// src/lib/nicknames.js
// Anonymous funny names for players ("Capivara Veloz"), like the anonymous
// animals in Google Docs. The player never types anything: a name is drawn
// when they join and kept while they keep playing. Lists are editable in the
// dashboard (settings collection, see src/modules/settings).
//
// Pure — randomness injectable for tests.

// Adjectives must work for both genders in Portuguese ("Capivara Veloz",
// "Pato Veloz"), so no -o/-a endings here.
export const DEFAULT_ADJECTIVES = [
  'Veloz', 'Feliz', 'Valente', 'Elegante', 'Gigante', 'Saltitante', 'Brilhante',
  'Sorridente', 'Tagarela', 'Audaz', 'Sagaz', 'Ágil', 'Gentil', 'Leal', 'Genial',
  'Radical', 'Estelar', 'Nobre', 'Alegre', 'Imponente', 'Persistente', 'Cintilante',
  'Fenomenal', 'Espacial', 'Turbo', 'Imbatível',
]

export const DEFAULT_ANIMALS = [
  'Capivara', 'Tamanduá', 'Preguiça', 'Tucano', 'Jabuti', 'Mico-Leão', 'Arara',
  'Lontra', 'Pinguim', 'Coruja', 'Lhama', 'Ornitorrinco', 'Suricato', 'Panda',
  'Polvo', 'Axolote', 'Quati', 'Tatu', 'Boto', 'Sagui', 'Jacaré', 'Ouriço',
  'Calango', 'Pavão', 'Flamingo', 'Alpaca', 'Camaleão', 'Gambá', 'Siri', 'Lagartixa',
]

export const MAX_ITEMS = 200
export const MAX_ITEM_LENGTH = 24

/**
 * Cleans an editable list: trims, drops empties/duplicates (case-insensitive),
 * caps length. Returns null when nothing usable is left.
 */
export function cleanList(list) {
  if (!Array.isArray(list)) return null
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const item = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_LENGTH)
    const key = item.toLocaleLowerCase('pt-BR')
    if (!item || seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= MAX_ITEMS) break
  }
  return out.length ? out : null
}

/**
 * Draws "Animal Adjetivo", avoiding names in `taken` when possible.
 * @param {{ animals: string[], adjectives: string[] }} lists
 * @param {Set<string>|string[]} taken  names currently in use in the instance
 * @param {() => number} random
 */
export function drawNickname({ animals, adjectives }, taken = new Set(), random = Math.random) {
  const used = taken instanceof Set ? taken : new Set(taken)
  const a = animals?.length ? animals : DEFAULT_ANIMALS
  const b = adjectives?.length ? adjectives : DEFAULT_ADJECTIVES
  const pick = (arr) => arr[Math.floor(random() * arr.length) % arr.length]

  for (let i = 0; i < 25; i++) {
    const name = `${pick(a)} ${pick(b)}`
    if (!used.has(name)) return name
  }
  // Everything nearby is taken (tiny lists or a huge queue): number it.
  const base = `${pick(a)} ${pick(b)}`
  for (let n = 2; n < 1000; n++) {
    if (!used.has(`${base} ${n}`)) return `${base} ${n}`
  }
  return base
}
