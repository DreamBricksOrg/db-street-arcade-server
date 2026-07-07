// src/lib/mutex.js
// Minimal per-key async mutex. Serializes "check then act" critical sections
// (e.g. resolving/creating a totem's session, claiming a player slot) so
// concurrent requests for the SAME key can't race each other — without
// needing a distributed lock, since this server runs as a single process.

/**
 * Creates a mutex keyed by an arbitrary string. Calls sharing a key run one
 * at a time, in call order; calls with different keys run independently.
 * @returns {(key: string, fn: () => Promise<any>) => Promise<any>}
 */
export function createKeyedMutex() {
  const chains = new Map() // key → tail promise of the current queue for that key

  return function withLock(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve()
    const run  = prev.then(fn, fn)
    // Keep the chain moving even if this run rejects; only the caller's
    // awaited `run` promise carries the real result/error.
    chains.set(key, run.catch(() => {}))
    return run
  }
}
