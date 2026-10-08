// src/lib/csv.js
// Session history as CSV for spreadsheets — pure.
//
// Separator `;` and a UTF-8 BOM: Excel in pt-BR uses the comma as the
// decimal separator and needs the BOM to read accents.

const SEP = ';'
const BOM = '﻿'

/** Quotes a cell when needed; neutralises spreadsheet formulas (=, +, -, @). */
export function csvCell(value) {
  if (value === null || value === undefined) return ''
  let s = value instanceof Date ? value.toISOString() : String(value)
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const REASON = {
  died: 'morreu', timeout: 'tempo esgotado', kicked: 'expulso', manual: 'encerrada pelo operador',
  no_show: 'não apareceu', instance_closed: 'site fechado',
}

const seconds = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000)) : '')

/**
 * @param {Array<object>} sessions  session documents
 * @param {Map<string,string>} totemNames  totemId → name
 */
export function sessionsCsv(sessions, totemNames = new Map()) {
  const header = [
    'totem', 'tela', 'site', 'jogador', 'situação', 'motivo do fim',
    'entrou na fila', 'chamado em', 'conectou em', 'terminou em',
    'espera (s)', 'jogo (s)', 'pontos',
  ]
  const lines = [header.map(csvCell).join(SEP)]
  for (const s of sessions) {
    const instance = !s.instanceId || s.instanceId === 'default' ? 'totem físico' : s.instanceId
    const site = s.site === 'preview' ? 'prévia do painel' : (s.site ?? '')
    lines.push([
      totemNames.get(s.totemId) ?? s.totemId,
      instance,
      site,
      s.nickname ?? '',
      s.status === 'finished' ? 'encerrada' : s.status === 'active' ? 'jogando' : 'reservada',
      REASON[s.endReason] ?? s.endReason ?? '',
      s.queuedAt ?? '',
      s.createdAt ?? '',
      s.startedAt ?? '',
      s.endedAt ?? '',
      seconds(s.queuedAt, s.createdAt),
      seconds(s.startedAt, s.endedAt),
      Number.isFinite(s.score) ? s.score : '',
    ].map(csvCell).join(SEP))
  }
  return BOM + lines.join('\r\n') + '\r\n'
}
