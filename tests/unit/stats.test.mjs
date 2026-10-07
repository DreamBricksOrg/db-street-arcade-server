// tests/unit/stats.test.mjs — per-totem history aggregation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeStats, isPlay } from '../../src/lib/stats.js'

const H = 3600_000
const NOW = Date.UTC(2026, 9, 7, 15, 30) // 07/10/2026 15:30 UTC

const at = (msAgo) => new Date(NOW - msAgo)

test('isPlay: conectou = jogou; no_show não; documento antigo sem startedAt pelo motivo', () => {
  assert.equal(isPlay({ startedAt: at(1), status: 'finished', endReason: 'died' }), true)
  assert.equal(isPlay({ status: 'finished', endReason: 'no_show' }), false)
  assert.equal(isPlay({ status: 'finished', endReason: 'timeout' }), true, 'legado')
  assert.equal(isPlay({ status: 'reserved' }), false)
  assert.equal(isPlay({ status: 'active' }), true)
})

test('24h: barras por hora, médias de espera e de jogo, desistências', () => {
  const sessions = [
    // jogou direto, 10 min de jogo, há 30 min (bucket da hora atual)
    { createdAt: at(30 * 60_000), startedAt: at(29 * 60_000), endedAt: at(19 * 60_000), status: 'finished', endReason: 'died' },
    // esperou 4 min na fila, 6 min de jogo, há ~2h
    { createdAt: at(2 * H), queuedAt: at(2 * H + 4 * 60_000), startedAt: at(2 * H - 60_000), endedAt: at(2 * H - 7 * 60_000), status: 'finished', endReason: 'timeout' },
    // chamado e não apareceu
    { createdAt: at(3 * H), queuedAt: at(3 * H + 2 * 60_000), status: 'finished', endReason: 'no_show' },
    // fora da janela
    { createdAt: at(30 * H), startedAt: at(30 * H), status: 'finished', endReason: 'died' },
  ]
  const s = computeStats(sessions, { range: '24h', now: NOW })
  assert.equal(s.buckets.length, 24)
  assert.equal(s.buckets.at(-1).plays, 1, 'hora atual')
  assert.equal(s.buckets.reduce((n, b) => n + b.plays, 0), 2)
  assert.deepEqual(s.totals, { sessions: 3, plays: 2, noShow: 1, waited: 1 })
  assert.equal(s.avgWaitMs, 4 * 60_000)
  assert.equal(s.avgPlayMs, 8 * 60_000)
  assert.equal(Math.round(s.noShowRate * 100), 33)
  assert.deepEqual(s.endReasons, { died: 1, timeout: 1, no_show: 1 })
})

test('7d: 7 barras diárias alinhadas à meia-noite local do operador', () => {
  // Brasília (UTC-3): getTimezoneOffset() = 180
  const s = computeStats([{ createdAt: at(H), startedAt: at(H), status: 'active' }], { range: '7d', now: NOW, tzOffsetMin: 180 })
  assert.equal(s.buckets.length, 7)
  const last = new Date(s.buckets.at(-1).t)
  assert.equal(last.getUTCHours(), 3, 'meia-noite em UTC-3 = 03:00 UTC')
  assert.equal(s.buckets.at(-1).plays, 1)
})

test('por site: totem físico, sites de origem e desconhecido', () => {
  const base = { createdAt: at(H), startedAt: at(H), status: 'active' }
  const s = computeStats([
    { ...base, instanceId: 'default' },
    { ...base, instanceId: 'a', site: 'https://loja.com' },
    { ...base, instanceId: 'b', site: 'https://loja.com' },
    { ...base, instanceId: 'c' },
  ], { now: NOW })
  assert.deepEqual(s.bySite, [
    { site: 'https://loja.com', plays: 2 },
    { site: 'totem', plays: 1 },
    { site: 'unknown', plays: 1 },
  ])
})

test('sem dados: zeros e médias nulas', () => {
  const s = computeStats([], { range: '30d', now: NOW })
  assert.equal(s.buckets.length, 30)
  assert.equal(s.avgWaitMs, null)
  assert.equal(s.noShowRate, 0)
})
