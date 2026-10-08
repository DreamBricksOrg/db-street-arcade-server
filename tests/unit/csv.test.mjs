// tests/unit/csv.test.mjs — session history CSV for spreadsheets.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { csvCell, sessionsCsv } from '../../src/lib/csv.js'

test('células: aspas e separador escapados, fórmulas neutralizadas, números intactos', () => {
  assert.equal(csvCell('a;b'), '"a;b"')
  assert.equal(csvCell('diz "oi"'), '"diz ""oi"""')
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"')
  assert.equal(csvCell('+55'), "'+55")
  assert.equal(csvCell('-12'), '-12')
  assert.equal(csvCell(null), '')
  assert.equal(csvCell(new Date(0)), '1970-01-01T00:00:00.000Z')
})

test('uma linha por sessão, com BOM, cabeçalho em português e tempos em segundos', () => {
  const csv = sessionsCsv([{
    totemId: 't1', instanceId: 'abc', site: 'https://loja.com', nickname: 'Capivara Veloz',
    status: 'finished', endReason: 'died', score: 120,
    queuedAt: new Date(1000), createdAt: new Date(61_000), startedAt: new Date(65_000), endedAt: new Date(125_000),
  }], new Map([['t1', 'Cabine A']]))
  assert.ok(csv.startsWith('\uFEFF'), 'BOM para o Excel')
  const [header, row] = csv.slice(1).trim().split('\r\n')
  assert.match(header, /^totem;tela;site;jogador;situação;motivo do fim;/)
  const cells = row.split(';')
  assert.deepEqual([cells[0], cells[1], cells[3], cells[4], cells[5]], ['Cabine A', 'abc', 'Capivara Veloz', 'encerrada', 'morreu'])
  assert.deepEqual(cells.slice(-3), ['60', '60', '120'], 'espera 60s, jogo 60s, 120 pontos')
})

test('configuração do jogo: schema de cada jogo e validação de faixa', async () => {
  const path = await import('node:path')
  const { gameConfigSchema, validateGameConfig } = await import('../../src/lib/games.js')
  const games = path.resolve('games')
  const snake = gameConfigSchema(games, 'snake')
  const brick = gameConfigSchema(games, 'brick-rush')
  assert.ok(snake.fields.some(f => f.key === 'gameSpeed'))
  assert.equal(brick.fields.find(f => f.key === 'roundMs').scale, 1000)
  assert.equal(gameConfigSchema(games, 'nao-existe'), null)
  assert.equal(validateGameConfig(brick, { roundMs: 90_000, extra: 'livre' }), null, 'chaves fora do schema passam')
  assert.match(validateGameConfig(brick, { roundMs: 5_000 }), /mínimo 20 s/)
  assert.match(validateGameConfig(snake, { gameSpeed: 'rápido' }), /número/)
  assert.match(validateGameConfig(snake, { debugPanel: 1 }), /ligado ou desligado/)
})
