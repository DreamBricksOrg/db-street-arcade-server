// public/player-store.js
// Remembers the player's id across tab closes and browser restarts, with a
// short validity: phones discard background tabs all the time, and losing the
// id meant losing your place in line (or your controller) for nothing.
//
// localStorage with a TTL (refreshed on every read); falls back to
// sessionStorage, then to memory, when storage is blocked (private mode).

const TTL_MS = 10 * 60_000
const memory = new Map()

function backend() {
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      const s = window[name]
      s.setItem('__sa_probe', '1')
      s.removeItem('__sa_probe')
      return s
    } catch { /* blocked */ }
  }
  return null
}

const store = backend()

/** @returns {string|null} the stored id, if still valid (and extends its life) */
export function getPlayer(key) {
  let raw = null
  try { raw = store ? store.getItem(key) : memory.get(key) ?? null } catch { /* blocked */ }
  if (!raw) return null
  let rec
  try { rec = JSON.parse(raw) } catch { rec = { id: raw, at: Date.now() } } // legacy plain value
  if (!rec?.id || Date.now() - rec.at > TTL_MS) {
    forgetPlayer(key)
    return null
  }
  setPlayer(key, rec.id)
  return rec.id
}

export function setPlayer(key, id) {
  const raw = JSON.stringify({ id, at: Date.now() })
  try { store ? store.setItem(key, raw) : memory.set(key, raw) } catch { memory.set(key, raw) }
}

export function forgetPlayer(key) {
  try { store ? store.removeItem(key) : memory.delete(key) } catch { memory.delete(key) }
}
