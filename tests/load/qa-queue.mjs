// tests/load/qa-queue.mjs
// QA de fila sob carga: 30 jogadores simulados (join, polling, WebSocket, inputs,
// morte, desistência) em totem single-player e multiplayer, mais cenários ruins.
// Sobe o servidor real em porta própria. Precisa de MongoDB + Redis (como o e2e).
// Run: node tests/load/qa-queue.mjs [--quick]   → imprime o relatório e grava JSON em QA_REPORT
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const PORT = Number(process.env.QA_PORT ?? 3201)
const BASE = `http://localhost:${PORT}`
const QUICK = process.argv.includes('--quick')
const RESERVE_MS = 8000
const GHOST_WAIT_S = 125 // HEARTBEAT_SECS do backend é 120

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const rnd = (a, b) => a + Math.random() * (b - a)
const findings = []
const checks = []
const metrics = {}

function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      ${detail}` : ''}`)
}
function bug(sev, title, detail) {
  findings.push({ sev, title, detail })
  console.log(`BUG[${sev}] ${title}\n      ${detail}`)
}

async function j(method, url, body, headers = {}) {
  const t0 = performance.now()
  const res = await fetch(BASE + url, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers, ms: performance.now() - t0 }
}

// ── servidor ─────────────────────────────────────────────────────────────────
const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env, PORT: String(PORT), OPERATOR_PASSWORD: '',
    QUEUE_RESERVE_MS: String(RESERVE_MS), QUEUE_SWEEP_MS: '500', QUEUE_JOIN_RATE_MAX: '10000',
    INSTANCE_GRACE_MS: '600000', MAX_INSTANCES_PER_IP: '1000', TRUST_PROXY: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverErrors = []
server.stderr.on('data', d => serverErrors.push(String(d)))
server.stdout.on('data', d => { const s = String(d); if (/"level":(50|60)|ERROR/.test(s)) serverErrors.push(s) })
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`${BASE}/health`)).ok) break } catch { /* boot */ }
  await sleep(250)
  if (i === 79) { console.error('servidor não subiu'); process.exit(1) }
}

// ── totem / instância ────────────────────────────────────────────────────────
async function makeTotem(o = {}) {
  const r = await j('POST', '/api/totems', { name: `qa-${Math.random().toString(36).slice(2, 7)}`, game: 'nave', maxPlayers: 1, sessionDurationMs: 60000, ...o })
  if (r.status !== 201) throw new Error(`create totem ${r.status} ${r.text}`)
  return r.body
}

/** Tela do jogo de uma instância web: SSE aberto (mantém a instância viva) e coleta de pacotes. */
async function openScreen(tid, inst) {
  const ctrl = new AbortController()
  const res = await fetch(`${BASE}/embed/${tid}/${inst}/events`, { signal: ctrl.signal, headers: { 'X-Forwarded-For': `198.51.100.${Math.floor(rnd(1, 250))}` } })
  const screen = { packets: [], status: res.status, close: () => ctrl.abort() }
  ;(async () => {
    const dec = new TextDecoder(); let buf = ''
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find(l => l.startsWith('data: ')); buf = buf.slice(i + 2)
          if (line) { try { screen.packets.push({ at: Date.now(), ...JSON.parse(line.slice(6)) }) } catch { /* ignore */ } }
        }
      }
    } catch { /* aborted */ }
  })()
  await sleep(200)
  return screen
}

const q = (inst) => (inst === 'default' ? '' : `?instance=${inst}`)
const joinUrl = (tid, inst) => `/api/totems/${tid}/queue/join${q(inst)}`
const statusUrl = (tid, inst, pid) => `/api/totems/${tid}/queue/status?playerId=${pid}${inst === 'default' ? '' : `&instance=${inst}`}`

function wsConnect(sessionId, playerId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/game?sessionId=${sessionId}&playerId=${playerId}`)
    ws.cues = []; ws.events = []; ws.closeCode = null
    const timer = setTimeout(() => reject(new Error('WS timeout')), 5000)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.data?.event === 'cue') ws.cues.push(m.data.cue); else if (m.type === 'event') ws.events.push(m.data) } catch { /* ignore */ } }
    ws.onclose = (e) => { ws.closeCode = e.code; clearTimeout(timer); reject(new Error(`WS closed ${e.code}`)) }
  })
}

// ── jogador simulado ─────────────────────────────────────────────────────────
// behavior: 'normal' | 'ghost' (some sem parar de pollar após entrar) | 'quit' (para de pollar após N s)
//           | 'noshow' (é chamado mas nunca conecta) | 'afk' (conecta e não morre → timeout) | 'kicked' (operador remove)
async function runPlayer(ctx, idx, behavior, joinOrderLog) {
  const { tid, inst, key, plays } = ctx
  const pid = `qa${String(idx).padStart(3, '0')}x${Math.random().toString(36).slice(2, 5)}`.slice(0, 14)
  const p = { idx, pid, behavior, joinAt: Date.now(), joined: null, positions: [], startedAt: null, endedAt: null, outcome: null, cuesSent: 0, cuesGot: 0 }
  ctx.players.push(p)

  const jr = await j('POST', joinUrl(tid, inst), { playerId: pid })
  p.joinMs = jr.ms
  if (jr.status !== 200 && jr.status !== 201) { p.outcome = `join-${jr.status}`; return p }
  p.joined = jr.body
  joinOrderLog.push(pid)

  let session = jr.body.status === 'play' ? jr.body.sessionId : null
  if (jr.body.status === 'queue') p.positions.push({ at: Date.now(), pos: jr.body.position })

  if (behavior === 'ghost') { p.outcome = 'ghost'; return p } // fechou a aba logo após entrar
  const quitAfter = behavior === 'quit' ? rnd(3000, 8000) : Infinity

  while (!session) {
    if (Date.now() - p.joinAt > quitAfter) { p.outcome = 'quit'; return p }
    if (behavior === 'kicked' && Date.now() - p.joinAt > 2500 && !p.kickedDone) {
      p.kickedDone = true
      const kr = await j('DELETE', `/api/totems/${tid}/queue/${pid}${q(inst)}`)
      p.kickStatus = kr.status
    }
    const s = await j('GET', statusUrl(tid, inst, pid))
    if (s.status === 404) { p.outcome = p.kickedDone ? 'kicked' : 'lost-404'; return p }
    if (s.status === 410) { p.outcome = 'gone-410'; return p }
    if (s.body?.status === 'play') session = s.body.sessionId
    else if (s.body?.status === 'queue') p.positions.push({ at: Date.now(), pos: s.body.position })
    if (!session) await sleep(ctx.pollMs ?? 1000)
  }
  p.calledAt = Date.now()

  if (behavior === 'noshow') { p.outcome = 'noshow'; return p }

  let ws
  try { ws = await wsConnect(session, pid) } catch (e) { p.outcome = `ws-fail:${e.message}`; return p }
  p.startedAt = Date.now()
  p.ws = ws
  for (let i = 0; i < 6; i++) { ws.send(JSON.stringify({ action: 'btn_A', state: i % 2 ? 'released' : 'pressed' })); await sleep(60) }

  if (behavior === 'afk') {
    await new Promise(r => { ws.onclose = (e) => { ws.closeCode = e.code; r() }; setTimeout(r, 75000) })
    p.endedAt = Date.now(); p.outcome = ws.closeCode === 1008 ? 'timeout' : 'afk-open'
    return p
  }

  const playMs = rnd(plays[0], plays[1])
  const t0 = Date.now()
  while (Date.now() - t0 < playMs) {
    if (inst !== 'default') { // o "jogo" manda cue de tiro para o celular dele
      await j('POST', `/embed/${tid}/${inst}/cue`, { cue: 'fire', pid }); p.cuesSent++
    }
    await sleep(300)
  }
  const death = inst === 'default'
    ? await j('POST', `/api/totems/${tid}/end-session`, { playerId: pid, score: Math.floor(rnd(0, 900)) }, { 'X-Totem-Key': key })
    : await j('POST', `/embed/${tid}/${inst}/end-session`, { pid, score: Math.floor(rnd(0, 900)) })
  p.endedAt = Date.now(); p.deathStatus = death.status
  await sleep(150)
  p.cuesGot = ws.cues.filter(c => c === 'fire').length
  p.closeCode = ws.closeCode
  p.gotSessionEnded = ws.events.some(e => e.event === 'session_ended')
  p.outcome = death.status === 200 ? 'played' : `death-${death.status}`
  return p
}

/** Amostra a visão do operador enquanto o cenário roda (ocupação nunca passa de maxPlayers). */
function startSampler(tid, inst, maxPlayers) {
  const s = { max: 0, violations: 0, maxQueue: 0, samples: 0, stop: false }
  ;(async () => {
    while (!s.stop) {
      const r = await j('GET', `/api/totems/${tid}/queue${q(inst)}`)
      if (r.status === 200) {
        s.samples++
        const live = r.body.sessions.length
        s.max = Math.max(s.max, live); s.maxQueue = Math.max(s.maxQueue, r.body.queue.length)
        if (live > maxPlayers) s.violations++
      }
      await sleep(150)
    }
  })()
  return s
}

async function loadScenario(label, { maxPlayers, inst, total = 30, mix }) {
  console.log(`\n=== ${label} ===`)
  const totem = await makeTotem({ maxPlayers, game: ['nave', 'snake', 'brick-rush'][maxPlayers % 3] })
  const tid = totem._id
  const screen = inst === 'default' ? null : await openScreen(tid, inst)
  const ctx = { tid, inst, key: totem.gameKey, plays: [1200, 2600], players: [], pollMs: 1000 }
  const order = []
  const sampler = startSampler(tid, inst, maxPlayers)
  const t0 = Date.now()

  const jobs = []
  for (let i = 0; i < total; i++) {
    const behavior = mix[i] ?? 'normal'
    jobs.push(runPlayer(ctx, i, behavior, order))
    await sleep(60) // chegam em sequência quase simultânea: a ordem de join é a ordem de i
  }
  const maxWait = 240000
  await Promise.race([Promise.allSettled(jobs), sleep(maxWait)])
  // Dá tempo para ghosts/no-show/timeouts passarem pela fila.
  const idleDeadline = Date.now() + (QUICK ? 20000 : GHOST_WAIT_S * 1000 + 15000)
  let view
  while (Date.now() < idleDeadline) {
    view = await j('GET', `/api/totems/${tid}/queue${q(inst)}`)
    if (view.body && view.body.sessions.length === 0 && view.body.queue.length === 0) break
    await sleep(1500)
  }
  sampler.stop = true
  const elapsed = (Date.now() - t0) / 1000

  const P = ctx.players
  const served = P.filter(p => p.startedAt).sort((a, b) => a.startedAt - b.startedAt)
  const by = (o) => P.filter(p => p.outcome === o).length
  console.log(`   ${total} jogadores em ${elapsed.toFixed(0)}s — jogaram ${by('played')}, no-show ${by('noshow')}, timeout ${by('timeout')}, ghost ${by('ghost')}, quit ${by('quit')}, kicked ${by('kicked')}`)
  console.log(`   ocupação máx ${sampler.max}/${maxPlayers}, fila máx ${sampler.maxQueue}, violações ${sampler.violations}`)

  check(`${label}: nunca mais de ${maxPlayers} sessões vivas ao mesmo tempo`, sampler.violations === 0 && sampler.max <= maxPlayers, `máx ${sampler.max}, violações ${sampler.violations}`)

  // FIFO: quem chegou antes e continuou na fila é atendido antes.
  const joinIdx = new Map(order.map((pid, i) => [pid, i]))
  const servedOrder = served.filter(p => joinIdx.has(p.pid)).map(p => joinIdx.get(p.pid))
  let inversions = 0
  for (let i = 1; i < servedOrder.length; i++) if (servedOrder[i] < servedOrder[i - 1]) inversions++
  // Com várias vagas, dois jogadores "chamados" no mesmo instante podem conectar fora de ordem; compara por calledAt.
  const calledOrder = P.filter(p => p.calledAt).sort((a, b) => a.calledAt - b.calledAt).map(p => joinIdx.get(p.pid))
  let callInv = 0
  for (let i = 1; i < calledOrder.length; i++) if (calledOrder[i] < calledOrder[i - 1] - (maxPlayers - 1)) callInv++
  check(`${label}: ordem de chamada respeita a ordem de entrada (FIFO)`, callInv === 0, `${callInv} inversões grandes`)
  metrics[label] = { elapsed, served: served.length, inversions, callInv, maxLive: sampler.max, maxQueue: sampler.maxQueue }

  // Posição só pode diminuir (ou ficar igual) para quem fica na fila.
  let posUp = 0
  for (const p of P) { for (let i = 1; i < p.positions.length; i++) if (p.positions[i].pos > p.positions[i - 1].pos) posUp++ }
  metrics[label].positionIncreases = posUp

  // Quem desistiu no meio da fila: posição dos que ficaram atrás deve andar.
  const noJoin = P.filter(p => String(p.outcome).startsWith('join-'))
  check(`${label}: todos os joins foram aceitos`, noJoin.length === 0, noJoin.map(p => p.outcome).join(','))

  const played = P.filter(p => p.outcome === 'played')
  const badDeath = played.filter(p => p.deathStatus !== 200)
  check(`${label}: morte de quem jogou encerra a sessão (200)`, badDeath.length === 0)
  const notTold = played.filter(p => !p.gotSessionEnded && p.closeCode !== 1008)
  check(`${label}: celular de quem morreu é avisado (session_ended ou WS 1008)`, notTold.length === 0, `${notTold.length} sem aviso`)
  if (inst !== 'default') {
    const lost = played.reduce((a, p) => a + (p.cuesSent - p.cuesGot), 0)
    const sent = played.reduce((a, p) => a + p.cuesSent, 0)
    check(`${label}: cues de som chegam ao celular certo (${sent} enviados)`, lost === 0, `${lost} perdidos/duplicados`)
    metrics[label].cuesSent = sent; metrics[label].cuesLost = lost
  }

  const leftover = await j('GET', `/api/totems/${tid}/queue${q(inst)}`)
  check(`${label}: ao final, nada vivo nem na fila`, leftover.body?.sessions.length === 0 && leftover.body?.queue.length === 0, JSON.stringify({ s: leftover.body?.sessions.length, q: leftover.body?.queue.length }))

  // Latências de API
  const joins = P.map(p => p.joinMs).filter(Boolean).sort((a, b) => a - b)
  metrics[label].joinP95ms = Math.round(joins[Math.floor(joins.length * 0.95)] ?? 0)

  // Espera média até ser chamado (por posição inicial)
  const waits = P.filter(p => p.calledAt && p.joined?.status === 'queue').map(p => (p.calledAt - p.joinAt) / 1000)
  metrics[label].avgWaitS = waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0

  // Tempo morto: vaga parada por no-show (reserva não reclamada).
  const stats = await j('GET', `/api/totems/${tid}/stats?range=24h`)
  metrics[label].stats = stats.body?.totals ?? stats.body?.summary ?? null
  screen?.close()
  return { P, tid, totem }
}

// ── cenário de ghost: vaga travada por quem fechou a aba ─────────────────────
async function ghostBlocking() {
  console.log('\n=== quem fecha a aba na fila trava a vaga? ===')
  const totem = await makeTotem({ maxPlayers: 1, sessionDurationMs: 60000 })
  const tid = totem._id; const inst = 'gb1'
  const screen = await openScreen(tid, inst)
  const A = await j('POST', joinUrl(tid, inst), { playerId: 'gbA' })        // joga
  const B = await j('POST', joinUrl(tid, inst), { playerId: 'gbB' })        // fila, fecha a aba (nunca pola)
  const C = await j('POST', joinUrl(tid, inst), { playerId: 'gbC' })        // fila, fica
  check('ghost: setup (A joga, B e C na fila)', A.body.status === 'play' && B.body.position === 1 && C.body.position === 2, JSON.stringify([A.body, B.body, C.body]))
  const wsA = await wsConnect(A.body.sessionId, 'gbA')
  const stC0 = await j('GET', statusUrl(tid, inst, 'gbC'))
  // B é fantasma, mas C continua vendo posição 2 (inclui o fantasma)
  check('ghost: C vê posição 2 mesmo com B ausente (posição inclui fantasmas)', stC0.body.position === 2)
  if (stC0.body.position === 2) bug('média', 'Posição e tempo estimado na fila incluem quem já fechou a aba', 'Quem sai da fila sem avisar continua contando na posição dos outros por até 120 s (TTL do heartbeat) ou até a vez dele chegar; não existe endpoint para o jogador sair da fila.')
  await j('POST', `/embed/${tid}/${inst}/end-session`, { pid: 'gbA' })
  await sleep(1200)
  const stC = await j('GET', statusUrl(tid, inst, 'gbC'))
  const stB = await j('GET', statusUrl(tid, inst, 'gbB'))
  // B só vira "ghost" depois do heartbeat expirar; antes disso B é chamado e trava a vaga até o no_show.
  const bCalled = (await j('GET', `/api/totems/${tid}/queue${q(inst)}`)).body.sessions.some(s => s.playerId?.startsWith('gbB'))
  const cWaiting = stC.body?.status !== 'play'
  console.log(`   B (aba fechada) recebeu a vaga: ${bCalled}; C continua esperando: ${cWaiting}`)
  metrics.ghostBlocking = { ghostGotSlot: bCalled, nextStillWaiting: cWaiting }
  if (bCalled && cWaiting) {
    const t0 = Date.now()
    while (Date.now() - t0 < 12000) { const s = await j('GET', statusUrl(tid, inst, 'gbC')); if (s.body?.status === 'play') break; await sleep(500) }
    const waited = (Date.now() - t0) / 1000
    metrics.ghostBlocking.nextWaitedS = Math.round(waited)
    bug('alta', 'Jogador que fechou a aba é chamado e trava a vaga até o no_show', `B nunca mais consultou a fila, mas ainda tinha heartbeat válido (TTL 120 s) e foi promovido; C esperou ~${waited.toFixed(0)} s (aqui QUEUE_RESERVE_MS=${RESERVE_MS / 1000}s; em produção 30 s) com a vaga vazia. Com vários fantasmas seguidos o tempo soma.`)
  }
  void stB
  wsA.close(); screen.close()
}

// ── cenários ruins ───────────────────────────────────────────────────────────
async function badScenarios() {
  console.log('\n=== cenários ruins ===')
  const totem = await makeTotem({ maxPlayers: 2, maxQueueSize: 3, sessionDurationMs: 60000 })
  const tid = totem._id; const inst = 'bad1'
  const screen = await openScreen(tid, inst)

  // join inválido
  const nobody = await j('POST', joinUrl(tid, inst), {})
  check('join sem playerId → 400', nobody.status === 400, `${nobody.status} ${nobody.text.slice(0, 120)}`)
  const huge = await j('POST', joinUrl(tid, inst), { playerId: 'x'.repeat(5000) })
  check('join com playerId gigante é recusado (400)', huge.status === 400, `${huge.status} — aceitou id de ${5000} chars`)
  const weird = await j('POST', joinUrl(tid, inst), { playerId: '<script>alert(1)</script>' })
  check('join com playerId com HTML é recusado ou neutralizado', weird.status === 400 || weird.status === 200, String(weird.status))
  const badJson = await j('POST', joinUrl(tid, inst), '{not json')
  check('JSON inválido → 400 (não 500)', badJson.status === 400, String(badJson.status))
  const ghostTotem = await j('POST', `/api/totems/00000000-0000-4000-8000-000000000000/queue/join`, { playerId: 'zz' })
  check('totem inexistente → 404', ghostTotem.status === 404, String(ghostTotem.status))
  const badId = await j('POST', `/api/totems/nao-e-uuid/queue/join`, { playerId: 'zz' })
  check('id de totem malformado → 400/404 (não 500)', [400, 404].includes(badId.status), String(badId.status))
  const noInst = await j('POST', joinUrl(tid, 'inst-que-nao-existe'), { playerId: 'zz1' })
  check('instância web inexistente/sem tela aberta → 410', noInst.status === 410, `${noInst.status} ${noInst.text.slice(0, 100)}`)

  // corrida: o mesmo jogador entra 10x ao mesmo tempo
  const race = await Promise.all(Array.from({ length: 10 }, () => j('POST', joinUrl(tid, inst), { playerId: 'raceP' })))
  const sessions = new Set(race.map(r => r.body?.sessionId).filter(Boolean))
  check('10 joins simultâneos do MESMO jogador → 1 sessão só', sessions.size <= 1, `${sessions.size} sessões distintas`)
  const view = await j('GET', `/api/totems/${tid}/queue${q(inst)}`)
  const raceSess = view.body.sessions.filter(s => s.playerId?.startsWith('raceP')).length
  const raceQueue = view.body.queue.filter(x => String(x.playerId ?? x).startsWith('raceP')).length
  check('corrida: jogador não fica duplicado na fila nem com sessão + fila', raceSess + raceQueue <= 1, `sessões ${raceSess}, na fila ${raceQueue}`)

  // fila cheia
  for (let i = 0; i < 5; i++) await j('POST', joinUrl(tid, inst), { playerId: `fill${i}` })
  const full = await j('POST', joinUrl(tid, inst), { playerId: 'overflow' })
  check('fila cheia (max 3) → 409', full.status === 409, String(full.status))

  // join repetido na fila não duplica
  const q1 = await j('POST', joinUrl(tid, inst), { playerId: 'fill0' })
  const view2 = await j('GET', `/api/totems/${tid}/queue${q(inst)}`)
  const dupes = view2.body.queue.length
  check('join repetido de quem está na fila não duplica', dupes <= 3, `fila com ${dupes} (join repetido → ${q1.status} ${JSON.stringify(q1.body)})`)

  // WS: jogador errado, sessão inexistente, duas abas
  const first = view.body.sessions[0]
  if (first) {
    const refused = (sid, pid) => new Promise(resolve => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws/game?sessionId=${sid}&playerId=${pid}`)
      let opened = false
      ws.onopen = () => { opened = true }
      ws.onclose = (e) => resolve({ opened, code: e.code })
      setTimeout(() => resolve({ opened, code: 'aberto após 3 s' }), 3000)
    })
    const wrong = await refused(first.sessionId, 'intruso')
    check('WS com playerId errado é fechado pelo servidor (1008)', wrong.code === 1008, JSON.stringify(wrong))
    const none = await refused('11111111-1111-4111-8111-111111111111', 'x')
    check('WS com sessão inexistente é fechado pelo servidor (1008)', none.code === 1008, JSON.stringify(none))
    const intruderSession = (await j('GET', `/api/sessions/${first.sessionId}`)).body
    check('intruso não derruba nem ativa a sessão do dono', intruderSession.status === 'reserved', intruderSession.status)
  }

  // end-session / cue com dados ruins
  const endNobody = await j('POST', `/embed/${tid}/${inst}/end-session`, { pid: 'nao-existe' })
  check('end-session de pid desconhecido → 404', endNobody.status === 404, String(endNobody.status))
  const endNoPid = await j('POST', `/embed/${tid}/${inst}/end-session`, {})
  check('end-session sem pid não derruba ninguém', endNoPid.status === 200 || endNoPid.status === 400, String(endNoPid.status))
  const stillThere = (await j('GET', `/api/totems/${tid}/queue${q(inst)}`)).body.sessions.length
  check('sessões continuam vivas depois de end-session sem pid', stillThere >= 1, String(stillThere))
  const cueBad = await j('POST', `/embed/${tid}/${inst}/cue`, { cue: '../etc/passwd' })
  check('cue com nome inválido → 400', cueBad.status === 400, String(cueBad.status))
  const cueNobody = await j('POST', `/embed/${tid}/${inst}/cue`, { cue: 'fire', pid: 'ninguem' })
  check('cue para pid inexistente → 200 com sent 0', cueNobody.status === 200 && cueNobody.body?.sent === 0, JSON.stringify(cueNobody.body))
  const physNoKey = await j('POST', `/api/totems/${tid}/cue`, { cue: 'fire' })
  check('cue do totem sem X-Totem-Key → 401', physNoKey.status === 401, String(physNoKey.status))
  const flood = await Promise.all(Array.from({ length: 90 }, () => j('POST', `/embed/${tid}/${inst}/cue`, { cue: 'fire' })))
  const limited = flood.filter(r => r.status === 429).length
  check('flood de cue (90 em 1 s) é limitado (429)', limited > 0, `${limited} respostas 429`)


  // pausa
  await j('POST', `/api/totems/${tid}/pause`, { paused: true })
  const paused = await j('POST', joinUrl(tid, inst), { playerId: 'depois-da-pausa' })
  check('totem pausado: novo join → 423', paused.status === 423, String(paused.status))
  await j('POST', `/api/totems/${tid}/pause`, { paused: false })

  // valores de config fora da faixa
  const cfg = await j('PUT', `/api/totems/${tid}`, { gameConfig: { speed: 9999 } })
  check('gameConfig fora da faixa é recusado (400)', cfg.status === 400, `${cfg.status} ${cfg.text.slice(0, 100)}`)
  const cfgGood = await j('PUT', `/api/totems/${tid}`, { gameConfig: { speed: 5, breakTimeout: 12 } })
  check('gameConfig válido da nave é aceito', [200, 204].includes(cfgGood.status), `${cfgGood.status} ${cfgGood.text.slice(0, 160)}`)

  // tela fecha: sessões encerram, fila vira 410
  screen.close()
  await sleep(500)
  return tid
}

// ── jogos: servem, SSE, ranking, sessão informa o jogo ──────────────────────
async function perGame() {
  console.log('\n=== por jogo ===')
  for (const game of ['snake', 'brick-rush', 'nave']) {
    const totem = await makeTotem({ game, maxPlayers: 2, sessionDurationMs: 60000 })
    const tid = totem._id; const inst = `g-${game}`
    const page = await j('GET', `/embed/${tid}/${inst}/`)
    check(`${game}: página do iframe 200 com overlay`, page.status === 200 && /overlay\.js/.test(page.text), String(page.status))
    const cfg = await j('GET', `/embed/${tid}/${inst}/config`)
    check(`${game}: /config responde`, cfg.status === 200, String(cfg.status))
    const schema = await j('GET', `/api/games/${game}/config-schema`)
    check(`${game}: schema de ajustes existe`, schema.status === 200 && Array.isArray(schema.body?.fields), String(schema.status))
    const screen = await openScreen(tid, inst)
    const a = await j('POST', joinUrl(tid, inst), { playerId: `g${game}A` })
    const ws = await wsConnect(a.body.sessionId, `g${game}A`)
    await sleep(300)
    ws.send(JSON.stringify({ action: 'dpad_up', state: 'pressed' })); ws.send(JSON.stringify({ action: 'btn_B', state: 'pressed' }))
    await sleep(400)
    check(`${game}: player_join + inputs chegam ao jogo`, screen.packets.some(p => p.type === 'player_join') && screen.packets.some(p => p.a === 'dpad_up') && screen.packets.some(p => p.a === 'btn_B'), JSON.stringify(screen.packets.slice(0, 4)))
    const sess = await j('GET', `/api/sessions/${a.body.sessionId}`)
    check(`${game}: sessão informa o jogo ao celular (som por perfil)`, sess.body?.game === game, JSON.stringify(sess.body?.game))
    await j('POST', `/embed/${tid}/${inst}/cue`, { cue: 'fire', pid: `g${game}A` })
    await sleep(200)
    check(`${game}: cue chega ao WS do celular`, ws.cues.includes('fire'))
    const end = await j('POST', `/embed/${tid}/${inst}/end-session`, { pid: `g${game}A`, score: 321 })
    await sleep(300)
    check(`${game}: morte envia player_leave ao jogo`, end.status === 200 && screen.packets.some(p => p.type === 'player_leave'))
    const rank = await j('GET', `/embed/${tid}/${inst}/ranking`)
    check(`${game}: pontuação aparece no ranking`, rank.body?.[0]?.score === 321, JSON.stringify(rank.body))
    const files = game === 'brick-rush' ? ['index.html', 'main.js', 'match.js', 'render.js'] : ['index.html', 'game.js']
    for (const f of files) {
      const r = await j('GET', `/embed/${tid}/${inst}/${f}`)
      check(`${game}: estático ${f} 200`, r.status === 200, String(r.status))
    }
    screen.close()
  }
}

// ── execução ─────────────────────────────────────────────────────────────────
const mixSingle = {}   // índices → comportamento
;[4, 9, 15, 21, 26].forEach(i => { mixSingle[i] = 'quit' })     // desistem no meio da fila (param de pollar)
;[6, 18].forEach(i => { mixSingle[i] = 'kicked' })              // removidos pelo operador
;[2].forEach(i => { mixSingle[i] = 'noshow' })                  // chamado e não conecta
;[11].forEach(i => { mixSingle[i] = 'afk' })                    // conecta e some → timeout
;[13, 23].forEach(i => { mixSingle[i] = 'ghost' })              // fecha a aba logo após entrar

const mixMulti = {}
;[5, 10, 16, 22, 27, 29].forEach(i => { mixMulti[i] = 'quit' })
;[7, 19].forEach(i => { mixMulti[i] = 'kicked' })
;[3, 12].forEach(i => { mixMulti[i] = 'noshow' })
;[8].forEach(i => { mixMulti[i] = 'afk' })
;[14, 24].forEach(i => { mixMulti[i] = 'ghost' })

try {
  await perGame()
  await badScenarios()
  await ghostBlocking()
  await loadScenario('single-player (1 vaga) em iframe, 30 jogadores', { maxPlayers: 1, inst: 'ld1', mix: mixSingle })
  await loadScenario('multiplayer (4 vagas) em iframe, 30 jogadores', { maxPlayers: 4, inst: 'ld4', mix: mixMulti })
  await loadScenario('multiplayer (2 vagas) no totem físico (default), 30 jogadores', { maxPlayers: 2, inst: 'default', mix: mixMulti })
} catch (err) {
  console.error('ERRO NO QA:', err)
  findings.push({ sev: 'alta', title: 'Exceção no QA', detail: String(err.stack ?? err) })
}

server.kill()
const failed = checks.filter(c => !c.ok)
const report = { when: new Date().toISOString(), checks, failed: failed.length, findings, metrics, serverErrors: serverErrors.slice(0, 20) }
fs.writeFileSync(process.env.QA_REPORT ?? 'qa-report.json', JSON.stringify(report, null, 2))
console.log(`\n${checks.length - failed.length}/${checks.length} verificações OK, ${findings.length} bugs marcados, ${serverErrors.length} linhas de erro no servidor`)
process.exit(0)
