// tests/load/qa-browser.mjs
/* global window, document, phase, players, maxPlayers, lastScore -- trechos de page.evaluate rodam dentro da página */
// QA em navegador real: cada jogo no iframe (desktop) + celulares (Pixel 7) jogando,
// com som (WebAudio instrumentado), gamepad e fim de jogo. Sobe o servidor em porta própria.
// Run: node tests/load/qa-browser.mjs   (MongoDB + Redis + chromium do Playwright)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { chromium, devices } from '@playwright/test'

const PORT = Number(process.env.QA_PORT ?? 3202)
const BASE = `http://localhost:${PORT}`
const SHOTS = process.env.QA_SHOTS ?? '.'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const checks = []
const findings = []
const check = (name, ok, detail = '') => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n      ${detail}` : ''}`) }

const server = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(PORT), OPERATOR_PASSWORD: '', QUEUE_RESERVE_MS: '20000', QUEUE_SWEEP_MS: '500', QUEUE_JOIN_RATE_MAX: '1000', MAX_INSTANCES_PER_IP: '1000', TRUST_PROXY: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const serverErr = []
server.stderr.on('data', d => serverErr.push(String(d)))
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break } catch { /* boot */ } await sleep(250) }

async function api(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text(); let b = null; try { b = JSON.parse(t) } catch { /* */ }
  return { status: r.status, body: b }
}

// Conta osciladores/ruídos criados e o estado do AudioContext (o headless não "toca", mas agenda).
const AUDIO_SPY = () => {
  window.__audio = { osc: 0, noise: 0, states: [] }
  const AC = window.AudioContext
  if (!AC) return
  const co = AC.prototype.createOscillator
  AC.prototype.createOscillator = function () { window.__audio.osc++; window.__audio.states.push(this.state); return co.call(this) }
  const cb = AC.prototype.createBufferSource
  AC.prototype.createBufferSource = function () { window.__audio.noise++; return cb.call(this) }
}

const browser = await chromium.launch()
const errorsOf = (page, bucket, label) => {
  page.on('pageerror', e => bucket.push(`${label} pageerror: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') bucket.push(`${label} console.error: ${m.text()}`) })
  page.on('requestfailed', r => bucket.push(`${label} requestfailed: ${r.url()} ${r.failure()?.errorText}`))
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) bucket.push(`${label} HTTP ${r.status()} ${r.url().replace(BASE, '')}`) })
}

async function phone(totemId, inst, label, errs) {
  const ctx = await browser.newContext({ ...devices['Pixel 7'], baseURL: BASE })
  await ctx.addInitScript(AUDIO_SPY)
  const page = await ctx.newPage()
  errorsOf(page, errs, label)
  await page.goto(`/play/totem?id=${totemId}&instance=${inst}`)
  await page.waitForURL(/\/play\/[0-9a-f-]{36}/, { timeout: 15000 }).catch(() => {})
  return { ctx, page }
}

const hold = async (page, sel, ms) => {
  const el = page.locator(sel)
  const box = await el.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down(); await sleep(ms); await page.mouse.up()
}

try {
  for (const game of ['nave', 'snake', 'brick-rush']) {
    console.log(`\n=== ${game} (navegador real) ===`)
    const errs = []
    const totem = (await api('POST', '/api/totems', { name: `qb-${game}`, game, maxPlayers: 2, sessionDurationMs: 60000, ...(game === 'nave' ? { gameConfig: { speed: 2, breakTimeout: 6, lobbyWaitMs: 20000 } } : {}) })).body
    const screen = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, baseURL: BASE, extraHTTPHeaders: {} })).newPage()
    errorsOf(screen, errs, 'tela')
    await screen.goto(`/embed/${totem._id}?showqr=true`)
    const inst = screen.url().match(/\/embed\/[^/]+\/([^/]+)\//)[1]
    await sleep(1200)
    await screen.screenshot({ path: `${SHOTS}/${game}-1-tela-vazia.png` })
    const blank = await screen.evaluate(() => { const c = document.querySelector('canvas'); if (!c) return 'sem-canvas'; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4000) if (d[i] || d[i + 1] || d[i + 2]) n++; return n })
    check(`${game}: tela do jogo desenha (canvas não está em branco)`, blank !== 'sem-canvas' && blank > 0, String(blank))
    check(`${game}: cartão de QR do iframe visível`, await screen.locator('.dbx-qr').isVisible())

    const A = await phone(totem._id, inst, 'celularA', errs)
    const sidA = A.page.url().match(/\/play\/([0-9a-f-]{36})/)?.[1]
    check(`${game}: QR → celular A entra e abre o gamepad`, Boolean(sidA) && await A.page.locator('#gamepad').isVisible({ timeout: 8000 }).catch(() => false), A.page.url())

    // Som: sem gesto o navegador bloqueia → aparece o aviso; um toque liga e a música agenda notas.
    const gate = await A.page.locator('#sound-gate').waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false)
    const stateBefore = await A.page.evaluate(() => window.__audio.states.at(-1) ?? 'nenhum')
    console.log(`   som: aviso "toque para ligar" ${gate ? 'apareceu' : 'não apareceu'} (AudioContext ${stateBefore})`)
    if (gate) await A.page.locator('#sound-gate').click()
    await sleep(1500)
    const audio = await A.page.evaluate(() => window.__audio)
    check(`${game}: música começa a agendar notas depois do toque`, audio.osc > 10, JSON.stringify(audio))
    check(`${game}: aviso de som some depois do toque`, !(await A.page.locator('#sound-gate').isVisible()))

    // Mudo
    const before = audio.osc
    await A.page.locator('#sound-btn').click(); await sleep(150)
    check(`${game}: botão de som vira 🔇`, (await A.page.locator('#sound-btn').textContent()).includes('🔇'))
    await A.page.locator('#sound-btn').click(); await sleep(150)
    void before

    const B = await phone(totem._id, inst, 'celularB', errs)
    await sleep(1000)
    await screen.screenshot({ path: `${SHOTS}/${game}-2-dois-jogadores.png` })

    // Inputs reais pelo gamepad
    await hold(A.page, '#btn-right', 400); await hold(A.page, '#btn-A', 300); await hold(A.page, '#btn-B', 300); await hold(B.page, '#btn-up', 400)
    await sleep(500)

    if (game === 'nave') {
      // Lobby com 2 de 2 vagas → contagem → partida
      const st = await screen.evaluate(() => ({ phase, players: Object.keys(players).length, maxPlayers }))
      console.log('   nave estado:', JSON.stringify(st))
      check('nave: 2 jogadores conectados aparecem no jogo', st.players === 2, JSON.stringify(st))
      await screen.waitForFunction(() => phase === 'play', null, { timeout: 8000 }).catch(() => {})
      const play = await screen.evaluate(() => ({ phase, timers: Object.values(players).map(p => Math.round(p.timer * 10) / 10) }))
      check('nave: vagas lotadas → contagem e partida começa', play.phase === 'play', JSON.stringify(play))
      await screen.screenshot({ path: `${SHOTS}/nave-3-partida.png` })
      // Sem quebrar bloco, o timer (6 s) ou um bloco encerra a partida; os dois celulares recebem o fim
      await screen.waitForFunction(() => phase === 'lobby', null, { timeout: 15000 }).catch(() => {})
      const after = await screen.evaluate(() => ({ phase, total: Object.keys(players).length, last: lastScore }))
      check('nave: quem não quebra bloco explode e a partida volta ao lobby', after.phase === 'lobby' && after.last !== null, JSON.stringify(after))
      const ended = await Promise.all([A.page.locator('#error-title').textContent({ timeout: 4000 }).catch(() => ''), B.page.locator('#error-title').textContent({ timeout: 4000 }).catch(() => '')])
      check('nave: os dois celulares mostram "Fim de jogo"', ended.every(t => /Fim de jogo/.test(t)), JSON.stringify(ended))
      await screen.screenshot({ path: `${SHOTS}/nave-4-fim.png` })
    } else {
      // snake expõe `players`; o brick-rush é módulo ES (estado interno, HUD no canvas): só o screenshot e a ausência de erros o cobrem
      if (game === 'snake') {
        const st = await screen.evaluate(() => Object.keys(players).length)
        check('snake: jogo reconhece os jogadores pelos inputs do celular', st >= 1, String(st))
      }
      await screen.screenshot({ path: `${SHOTS}/${game}-3-jogando.png` })
    }

    // Erros de console/rede de qualquer página desse jogo
    const real = errs.filter(e => !/net::ERR_ABORTED|favicon|fonts\.g(oogleapis|static)/.test(e))
    check(`${game}: sem erro de JS/console/rede nas telas`, real.length === 0, real.slice(0, 6).join(' | '))
    await A.ctx.close(); await B.ctx.close(); await screen.context().close()
  }
} catch (err) {
  console.error('ERRO NO QA-BROWSER:', err)
  findings.push({ sev: 'alta', title: 'Exceção no QA de navegador', detail: String(err.stack ?? err) })
}
await browser.close()
server.kill()
const failed = checks.filter(c => !c.ok)
fs.writeFileSync(process.env.QA_REPORT_BROWSER ?? 'qa-browser-report.json', JSON.stringify({ checks, failed: failed.length, findings, serverErr: serverErr.slice(0, 10) }, null, 2))
console.log(`\n${checks.length - failed.length}/${checks.length} OK; ${findings.length} bugs; ${serverErr.length} erros do servidor`)
process.exit(0)
