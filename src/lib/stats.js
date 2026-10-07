// src/lib/stats.js
// Per-totem history from session documents — pure, no I/O.
//
// A session is a PLAY when the phone actually connected (startedAt set, or —
// for documents older than startedAt — it ended for any reason other than
// no_show). no_show = called from the line but never connected.

export const RANGES = {
  '24h': { ms: 24 * 3600_000, bucketMs: 3600_000 },
  '7d':  { ms: 7 * 86_400_000, bucketMs: 86_400_000 },
  '30d': { ms: 30 * 86_400_000, bucketMs: 86_400_000 },
}

const time = (d) => (d ? new Date(d).getTime() : null)

export function isPlay(s) {
  if (s.startedAt) return true
  if (s.status === 'active') return true
  return s.status === 'finished' && s.endReason && s.endReason !== 'no_show'
}

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)

/**
 * @param {Array<object>} sessions  docs with createdAt/queuedAt/startedAt/endedAt/endReason/instanceId/site
 * @param {{ range?: keyof RANGES, now?: number, tzOffsetMin?: number }} opts
 *   tzOffsetMin: the viewer's Date#getTimezoneOffset(), so daily buckets start at local midnight
 */
export function computeStats(sessions, { range = '24h', now = Date.now(), tzOffsetMin = 0 } = {}) {
  const { ms, bucketMs } = RANGES[range] ?? RANGES['24h']
  const shift = -tzOffsetMin * 60_000
  const floor = (t) => Math.floor((t + shift) / bucketMs) * bucketMs - shift
  const first = floor(now - ms) + bucketMs
  const buckets = []
  for (let t = first; t <= floor(now); t += bucketMs) buckets.push({ t, plays: 0 })
  const index = new Map(buckets.map((b, i) => [b.t, i]))

  const reasons = {}
  const sites = new Map()
  const waits = [], plays = []
  let total = 0, played = 0, noShow = 0, waited = 0

  for (const s of sessions) {
    const created = time(s.createdAt)
    if (created === null || created < now - ms) continue
    total++
    if (s.endReason) reasons[s.endReason] = (reasons[s.endReason] ?? 0) + 1
    if (s.endReason === 'no_show') noShow++
    if (!isPlay(s)) continue

    played++
    const i = index.get(floor(created))
    if (i !== undefined) buckets[i].plays++

    const queued = time(s.queuedAt)
    if (queued !== null && created >= queued) { waits.push(created - queued); waited++ }
    const started = time(s.startedAt), ended = time(s.endedAt)
    if (started !== null && ended !== null && ended > started) plays.push(ended - started)

    const site = !s.instanceId || s.instanceId === 'default' ? 'totem' : (s.site ?? 'unknown')
    sites.set(site, (sites.get(site) ?? 0) + 1)
  }

  return {
    range,
    bucketMs,
    since: now - ms,
    buckets,
    totals: { sessions: total, plays: played, noShow, waited },
    avgWaitMs: avg(waits),
    avgPlayMs: avg(plays),
    noShowRate: total ? noShow / total : 0,
    endReasons: reasons,
    bySite: [...sites].map(([site, n]) => ({ site, plays: n })).sort((a, b) => b.plays - a.plays),
  }
}
