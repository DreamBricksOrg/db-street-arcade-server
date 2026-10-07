// public/dashboard.js
// Operator dashboard — totem CRUD, live occupancy, queue control, embed codes.
//
//   - CRUD against /api/totems
//   - Each card polls /api/totems/:id/instances (physical totem + open iframes)
//     every 10s; the same rows feed the card and the stat cards on top
//   - Queue dialog polls /queue every 5s, per instance
//   - Confirmations and notices use the DreamBricks Dialog / Toast (native
//     <dialog>, so focus trap + Escape come from the browser)

const API = '/api/totems'

const $ = (id) => document.getElementById(id)
const icon = (name, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`

// ── DOM refs ──────────────────────────────────────────────────────────────────
const totemList   = $('totem-list')
const totemEmpty  = $('totem-empty')
const totemNoMatch = $('totem-nomatch')
const searchInput = $('search')
const tabs        = [...document.querySelectorAll('.db-tab[data-filter]')]

const totemDialog    = $('totemDialog')
const totemForm      = $('totem-form')
const totemFormTitle = $('totem-form-title')
const totemError     = $('totem-error')
const formName       = $('tf-name')
const formUrl        = $('tf-url')
const formMaxPlayers = $('tf-max-players')
const formDuration   = $('tf-duration')
const formMaxQueue   = $('tf-max-queue')
const formGame       = $('tf-game')
const formGameConfig = $('tf-game-config')
const btnSaveTotem   = $('btn-save-totem')

const queueDialog      = $('queueDialog')
const queueTotemName   = $('queue-totem-name')
const queueBody        = $('queue-body')
const queueInstanceBar = $('queue-instance-bar')
const queueInstanceSel = $('queue-instance')

const qrDialog = $('qrDialog')
const qrTitle  = $('qr-title')
const qrBox    = $('qr-box')

const confirmDialog = $('confirmDialog')
const confirmTitle  = $('confirm-title')
const confirmDesc   = $('confirm-desc')
const confirmOk     = $('confirm-ok')

const embedDialog     = $('embedDialog')
const embedTotemName  = $('embed-totem-name')
const embedPreview    = $('embed-preview')
const embedResponsive = $('embed-responsive')
const embedShowQr     = $('embed-showqr')
const embedWidth      = $('embed-width')
const embedHeight     = $('embed-height')
const embedCode       = $('embed-code')
const embedCopy       = $('embed-copy')
const embedOpen       = $('embed-open')

const toastStack = $('toasts')

// ── State ─────────────────────────────────────────────────────────────────────
let totems         = []
let filter         = 'all'
let editingTotemId = null
let cardPollTimers = {}          // totemId → intervalId
const liveRows     = new Map()   // totemId → last /instances rows (for stats)
let queueTotem     = null
let queueTimer     = null
let queueInstance  = 'default'
let embedTotem     = null

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (res.status === 204) return null
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `Erro ${res.status}`)
  return body
}

/** `?instance=` suffix for the queue endpoints ('' for the physical totem). */
function instQs(instanceId, sep = '?') {
  return instanceId && instanceId !== 'default' ? `${sep}instance=${encodeURIComponent(instanceId)}` : ''
}

// ── Toast / Confirm (DreamBricks feedback components) ─────────────────────────

function toast(title, { tone = 'success', message = '', ms = 3200 } = {}) {
  const el = document.createElement('div')
  el.className = `db-toast db-toast--${tone}`
  el.setAttribute('role', tone === 'danger' ? 'alert' : 'status')
  el.innerHTML = `
    <div class="db-toast__body">
      <p class="db-toast__title">${escHtml(title)}</p>
      ${message ? `<p class="db-toast__msg">${escHtml(message)}</p>` : ''}
    </div>
    <button class="db-icon-btn" type="button" aria-label="Fechar aviso"><svg><use href="#i-x"/></svg></button>`
  const close = () => {
    el.classList.add('is-leaving')
    setTimeout(() => el.remove(), 200)
  }
  el.querySelector('button').addEventListener('click', close)
  toastStack.appendChild(el)
  setTimeout(close, ms)
}

/** Resolves true when the operator confirms. Cancel is focused by default. */
function confirmAction({ title, message, confirmLabel }) {
  confirmTitle.textContent = title
  confirmDesc.textContent  = message
  confirmOk.textContent    = confirmLabel
  confirmDialog.returnValue = ''
  confirmDialog.showModal()
  return new Promise((resolve) => {
    confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'ok'), { once: true })
  })
}

// Clicking the dimmed backdrop closes any dialog (the click lands on <dialog> itself).
// [data-close] buttons are type="button" so Enter in a field never hits them.
for (const d of document.querySelectorAll('dialog.db-dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close('cancel')
  })
}

// ── Load & Render ──────────────────────────────────────────────────────────────

async function loadGames() {
  const games = await apiFetch('/api/games').catch(() => [])
  for (const g of games ?? []) {
    const opt = document.createElement('option')
    opt.value = g
    opt.textContent = g
    formGame.appendChild(opt)
  }
}

export async function loadTotems() {
  Object.values(cardPollTimers).forEach(clearInterval)
  cardPollTimers = {}
  liveRows.clear()

  let list
  try {
    list = await apiFetch(API)
    setLive(true)
  } catch {
    list = []
    setLive(false)
  }
  totems = list ?? []

  totemList.innerHTML = ''
  for (const t of totems) {
    const card = buildTotemCard(t)
    totemList.appendChild(card)
    startCardPoll(t, card)
  }

  updateCounts()
  applyFilter()
  renderStats()
  window.dispatchEvent(new CustomEvent('totems:updated', { detail: { totems } }))
  return totems
}

function kindOf(t) {
  return { physical: Boolean(t.ip), web: Boolean(t.game) }
}

function updateCounts() {
  $('cnt-all').textContent      = totems.length
  $('cnt-physical').textContent = totems.filter(t => kindOf(t).physical).length
  $('cnt-web').textContent      = totems.filter(t => kindOf(t).web).length
}

function applyFilter() {
  const q = searchInput.value.trim().toLowerCase()
  let shown = 0
  for (const card of totemList.children) {
    const t = totems.find(x => x._id === card.dataset.id)
    if (!t) continue
    const k = kindOf(t)
    const okKind = filter === 'all' || (filter === 'physical' ? k.physical : k.web)
    const okText = !q || t.name.toLowerCase().includes(q) || t._id.startsWith(q) || (t.game ?? '').includes(q)
    card.hidden = !(okKind && okText)
    if (!card.hidden) shown++
  }
  totemEmpty.hidden   = totems.length > 0
  totemNoMatch.hidden = totems.length === 0 || shown > 0
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    filter = tab.dataset.filter
    for (const t of tabs) t.setAttribute('aria-selected', String(t === tab))
    applyFilter()
  })
}
searchInput.addEventListener('input', applyFilter)
$('btn-clear-filter').addEventListener('click', () => {
  searchInput.value = ''
  tabs[0].click()
})

function buildTotemCard(totem) {
  const { physical, web } = kindOf(totem)
  const entryUrl = `${window.location.origin}/play/totem?id=${totem._id}`
  const shortId  = totem._id.slice(0, 8)
  const name     = escHtml(totem.name)

  const card = document.createElement('article')
  card.className  = 'db-card db-card--hover totem'
  card.dataset.id = totem._id
  card.setAttribute('aria-label', totem.name)

  card.innerHTML = `
    <div class="totem__head">
      <div>
        <h3 class="totem__name">${name}</h3>
        <div class="totem__modes">
          <button class="id-chip" type="button" data-action="copy-id" data-tip="Copiar ID completo" aria-label="Copiar ID ${escHtml(totem._id)}">${shortId}</button>
          ${physical ? `<span class="db-tag" title="Endereço UDP da máquina">${escHtml(totem.ip)}:${totem.udpPort}</span>` : ''}
          ${web ? `<span class="db-badge db-badge--brand">${icon('globe')}Web · ${escHtml(totem.game)}</span>` : ''}
        </div>
      </div>
      <span data-status><span class="db-badge db-badge--dot">Verificando…</span></span>
    </div>

    <div class="totem__meta">
      <span>${icon('users')}${totem.maxPlayers ?? 2} por vez</span>
      <span>${icon('clock')}${formatDuration(totem.sessionDurationMs ?? 1800000)}</span>
      <span data-queue>${icon('list')}Fila: ${totem.queueSize || 0}${totem.maxQueueSize ? `/${totem.maxQueueSize}` : ''}</span>
      ${web ? `<span data-screens>${icon('monitor')}${screensLabel(totem.instances?.online ?? 0)}</span>` : ''}
    </div>

    ${physical ? `
    <div class="entry">
      <button class="entry__qr" type="button" data-action="qr" aria-label="Ampliar QR de ${name}">
        <img src="${API}/${totem._id}/qr" alt="" width="76" height="76" loading="lazy" />
      </button>
      <div class="entry__text">
        <span class="entry__title">Entrada do totem</span>
        <span class="entry__hint">Quem escaneia entra na fila desta máquina.</span>
        <div class="entry__actions">
          <button class="db-btn db-btn--ghost db-btn--sm" type="button" data-action="copy-link">${icon('copy')}Copiar link</button>
          <span data-end-all></span>
        </div>
      </div>
    </div>` : ''}

    <div class="totem__foot">
      <div class="totem__primary">
        ${web ? `<button class="db-btn db-btn--secondary db-btn--sm" type="button" data-action="embed">${icon('code')}Incorporar</button>` : ''}
        <button class="db-btn db-btn--secondary db-btn--sm" type="button" data-action="queue">${icon('list')}Fila</button>
      </div>
      <div class="totem__tools">
        <button class="db-icon-btn" type="button" data-action="edit" data-tip="Editar" aria-label="Editar ${name}"><svg><use href="#i-edit"/></svg></button>
        <button class="db-icon-btn" type="button" data-action="clear" data-tip="Limpar fila" aria-label="Limpar fila de ${name}"><svg><use href="#i-eraser"/></svg></button>
        <button class="db-icon-btn db-icon-btn--danger" type="button" data-action="delete" data-tip="Excluir" aria-label="Excluir ${name}"><svg><use href="#i-trash"/></svg></button>
      </div>
    </div>`

  const actions = {
    'embed':     () => openEmbedDialog(totem),
    'queue':     () => openQueueDialog(totem),
    'qr':        () => openQrDialog(totem),
    'edit':      () => startEdit(totem),
    'clear':     () => clearTotemQueue(totem),
    'delete':    () => deleteTotem(totem),
    'copy-id':   () => copy(totem._id, 'ID copiado'),
    'copy-link': () => copy(entryUrl, 'Link de entrada copiado', 'Cole no navegador do celular para testar.'),
    'end-all':   async () => {
      if (await endAllSessions(totem)) pollCardState(totem, card)
    },
  }
  card.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]')
    if (btn && card.contains(btn)) actions[btn.dataset.action]?.()
  })

  return card
}

async function copy(text, title, message) {
  try {
    await navigator.clipboard.writeText(text)
    toast(title, { message })
  } catch {
    toast('Não deu para copiar', { tone: 'danger', message: text })
  }
}

// ── Card polling ─────────────────────────────────────────────────────────────
// /instances gives per-instance counts: 'default' (physical totem) + every
// open iframe. The card sums them so a web totem's activity is visible too.

async function fetchTotemState(totemId) {
  try {
    const res = await fetch(`${API}/${totemId}/instances`)
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

function screensLabel(n) {
  return n === 1 ? '1 tela aberta' : `${n} telas abertas`
}

function renderCard(totem, card, rows) {
  const status = card.querySelector('[data-status]')
  const endAll = card.querySelector('[data-end-all]') ?? document.createElement('span')

  if (!rows) {
    status.innerHTML = '<span class="db-badge db-badge--danger db-badge--dot">Sem resposta</span>'
    endAll.innerHTML = ''
    return
  }

  const physical   = rows.find(r => r.id === 'default') ?? { sessions: 0, queueSize: 0 }
  const webRows    = rows.filter(r => r.id !== 'default')
  const webPlayers = webRows.reduce((n, r) => n + r.sessions, 0)
  const total      = physical.sessions + webPlayers

  if (total === 0) {
    status.innerHTML = '<span class="db-badge db-badge--dot">Livre</span>'
  } else {
    const parts = []
    if (totem.ip)   parts.push(`${physical.sessions}/${totem.maxPlayers ?? 2} no totem`)
    if (webPlayers) parts.push(`${webPlayers} na web`)
    status.innerHTML = `<span class="db-badge db-badge--success db-badge--dot db-badge--live">${parts.join(' · ')}</span>`
  }

  endAll.innerHTML = totem.ip && physical.sessions > 0
    ? `<button class="db-btn db-btn--danger db-btn--sm" type="button" data-action="end-all">${icon('power')}Encerrar todas</button>`
    : ''

  const queued  = rows.reduce((n, r) => n + r.queueSize, 0)
  const queueEl = card.querySelector('[data-queue]')
  queueEl.innerHTML   = `${icon('list')}Fila: ${queued}${totem.maxQueueSize ? `/${totem.maxQueueSize}` : ''}`
  queueEl.dataset.hot = String(queued > 0)

  const screensEl = card.querySelector('[data-screens]')
  if (screensEl) {
    const online = webRows.filter(r => r.online).length
    screensEl.innerHTML   = `${icon('monitor')}${screensLabel(online)}`
    screensEl.dataset.hot = String(online > 0)
  }
}

async function pollCardState(totem, card) {
  const rows = await fetchTotemState(totem._id)
  if (rows) liveRows.set(totem._id, rows); else liveRows.delete(totem._id)
  renderCard(totem, card, rows)
  renderStats()
}

function startCardPoll(totem, card) {
  pollCardState(totem, card)
  cardPollTimers[totem._id] = setInterval(() => pollCardState(totem, card), 10_000)
}

function renderStats() {
  const physicalN = totems.filter(t => kindOf(t).physical).length
  const webN      = totems.filter(t => kindOf(t).web).length
  let playing = 0, queued = 0, screens = 0
  for (const rows of liveRows.values()) {
    for (const r of rows) {
      playing += r.sessions
      queued  += r.queueSize
      if (r.id !== 'default' && r.online) screens++
    }
  }
  $('st-totems').textContent     = totems.length
  $('st-totems-sub').textContent = `${physicalN} físico${physicalN === 1 ? '' : 's'} · ${webN} web`
  $('st-playing').textContent    = playing
  $('st-queue').textContent      = queued
  $('st-queue').dataset.tone     = queued > 0 ? 'warning' : ''
  $('st-screens').textContent    = screens
}

// ── Server reachability (sidebar live indicator) ──────────────────────────────

function setLive(ok) {
  $('live').dataset.state = ok ? 'on' : 'off'
  $('live-text').textContent = ok ? 'ao vivo' : 'sem conexão'
}
setInterval(async () => {
  try { setLive((await fetch('/health')).ok) } catch { setLive(false) }
}, 15_000)

// ── Queue dialog ──────────────────────────────────────────────────────────────

function describeDevice(meta) {
  if (!meta) return null
  let ico = 'globe', text = 'Desconhecido'
  const ua = (meta.ua ?? '').toLowerCase()
  if (ua) {
    if (ua.includes('iphone'))        { ico = 'phone'; text = 'iPhone' }
    else if (ua.includes('ipad'))     { ico = 'phone'; text = 'iPad' }
    else if (ua.includes('android'))  {
      ico = 'phone'; text = 'Android'
      const model = meta.ua.split(';')[2]?.split(')')[0].trim()
      if (model && model.length < 20) text += ` (${model})`
    }
    else if (ua.includes('windows'))   { ico = 'monitor'; text = 'Windows' }
    else if (ua.includes('macintosh')) { ico = 'monitor'; text = 'Mac' }
    else if (ua.includes('linux'))     { ico = 'monitor'; text = 'Linux' }

    const browser = ua.includes('edg') ? 'Edge' : ua.includes('chrome') ? 'Chrome'
      : ua.includes('firefox') ? 'Firefox' : ua.includes('safari') ? 'Safari' : ''
    if (browser) text += ` · ${browser}`
  }
  const parts = [`<span>${icon(ico)}${escHtml(text)}</span>`]
  if (meta.ip)   parts.push(`<span class="db-mono">${escHtml(meta.ip)}</span>`)
  if (meta.lang) parts.push(`<span>${escHtml(meta.lang.split('-')[0].toUpperCase())}</span>`)
  return parts.join('')
}

function shortPid(pid) {
  const s = String(pid)
  return s.length > 14 ? `${s.slice(0, 14)}…` : s
}

async function renderQueue(totem) {
  let data
  try {
    const res = await fetch(`${API}/${totem._id}/queue${instQs(queueInstance)}`)
    data = res.ok ? await res.json() : null
  } catch { data = null }

  if (!data) {
    queueBody.innerHTML = `<div class="db-callout db-callout--danger">${icon('alert')}<span>Não deu para carregar a fila. Tentando de novo em 5s.</span></div>`
    return
  }

  const { queue = [], sessions = [], maxQueueSize = null } = data
  const cap = maxQueueSize ? ` de ${maxQueueSize}` : ''

  const summary = `
    <div class="queue-sum">
      <span class="db-badge db-badge--success db-badge--dot">${sessions.length} jogando</span>
      <span class="db-badge ${queue.length ? 'db-badge--warning' : ''} db-badge--dot">${queue.length}${cap} na fila</span>
    </div>`

  if (queue.length === 0 && sessions.length === 0) {
    queueBody.innerHTML = `${summary}<p class="q-empty" style="margin-top:12px">Ninguém jogando nem esperando agora.</p>`
    return
  }

  const playing = sessions.map((s) => {
    const pid  = String(s.playerId)
    const meta = describeDevice(s.metadata)
    return `
      <div class="q-row q-row--playing">
        <span class="q-pos" title="${s.status === 'active' ? 'Jogando' : 'Reservada'}">${icon('gamepad')}</span>
        <div class="q-main">
          <p class="q-pid" title="${escHtml(pid)}">${escHtml(shortPid(pid))}</p>
          <p class="q-meta">
            <span>${s.status === 'active' ? 'jogando' : 'reservada, aguardando o celular'}</span>
            <span class="db-mono" title="${escHtml(String(s.sessionId))}">sessão ${escHtml(String(s.sessionId).slice(0, 8))}</span>
            ${meta ?? ''}
          </p>
        </div>
        <button class="db-btn db-btn--danger db-btn--sm" type="button" data-kick-session="${escHtml(String(s.sessionId))}" data-player-id="${escHtml(pid)}">Expulsar</button>
      </div>`
  }).join('')

  const waiting = queue
    .filter(item => item && (typeof item === 'string' || item.id || item._id))
    .map((item, i) => {
      const pid  = String(typeof item === 'string' ? item : (item.id || item._id))
      const meta = describeDevice(item?.metadata)
      // Heartbeat TTL: null = no Redis, -2 = expired (ghost), -1 = no TTL, else seconds left.
      const ttl  = item?.heartbeatTtl
      const ghost = typeof ttl === 'number' && (ttl === -2 || ttl < 15)
      const eta  = item?.estimatedWaitMs
      return `
        <div class="q-row">
          <span class="q-pos">${i + 1}</span>
          <div class="q-main">
            <p class="q-pid" title="${escHtml(pid)}">${escHtml(shortPid(pid))}</p>
            <p class="q-meta">
              ${eta ? `<span>${icon('clock')}~${Math.max(1, Math.ceil(eta / 60000))} min</span>` : ''}
              ${ghost ? `<span data-warn>${icon('alert')}${ttl < 0 ? 'inativo' : `sai em ${ttl}s`}</span>` : ''}
              ${meta ?? ''}
            </p>
          </div>
          <button class="db-btn db-btn--danger db-btn--sm" type="button" data-kick-queue="${escHtml(pid)}">Remover</button>
        </div>`
    }).join('')

  queueBody.innerHTML = `
    ${summary}
    ${playing ? `<div class="q-section" style="margin-top:16px"><p class="q-section__title">Jogando</p>${playing}</div>` : ''}
    ${waiting ? `<div class="q-section" style="margin-top:16px"><p class="q-section__title">Na fila</p>${waiting}</div>` : ''}`
}

queueBody.addEventListener('click', async (e) => {
  const btn = e.target.closest('button')
  if (!btn || !queueTotem) return
  btn.disabled = true
  if (btn.dataset.kickSession) {
    await kickFromSession(btn.dataset.kickSession, btn.dataset.playerId)
  } else if (btn.dataset.kickQueue) {
    await kickFromQueue(queueTotem._id, btn.dataset.kickQueue)
  }
  renderQueue(queueTotem)
})

/** Fills the "Tela" selector: physical totem + every open iframe instance. */
async function refreshInstanceOptions(totem) {
  const rows = (await fetchTotemState(totem._id)) ?? [{ id: 'default', sessions: 0, queueSize: 0 }]
  const options = rows
    .filter(r => r.id === 'default' ? Boolean(totem.ip) || rows.length === 1 : true)
    .map(r => {
      const label = r.id === 'default'
        ? 'Totem físico'
        : `Tela ${r.id.slice(0, 8)}${r.online ? '' : ' (fechando)'}`
      return { id: r.id, label: `${label} · ${r.sessions} jogando · ${r.queueSize} na fila` }
    })
  if (!options.some(o => o.id === queueInstance)) queueInstance = options[0]?.id ?? 'default'

  queueInstanceSel.innerHTML = options
    .map(o => `<option value="${escHtml(o.id)}"${o.id === queueInstance ? ' selected' : ''}>${escHtml(o.label)}</option>`)
    .join('')
  queueInstanceBar.hidden = options.length <= 1
}

queueInstanceSel.addEventListener('change', () => {
  queueInstance = queueInstanceSel.value
  if (queueTotem) renderQueue(queueTotem)
})

async function openQueueDialog(totem) {
  queueTotem    = totem
  queueInstance = totem.ip ? 'default' : null
  queueTotemName.textContent = totem.name
  queueBody.innerHTML = '<p class="q-empty">Carregando…</p>'
  queueDialog.showModal()
  await refreshInstanceOptions(totem)
  renderQueue(totem)

  clearInterval(queueTimer)
  queueTimer = setInterval(async () => {
    await refreshInstanceOptions(totem)
    renderQueue(totem)
  }, 5_000)
}

queueDialog.addEventListener('close', () => {
  clearInterval(queueTimer)
  queueTimer = null
  queueTotem = null
})

async function kickFromQueue(totemId, playerId) {
  try {
    const res = await fetch(`${API}/${totemId}/queue/${encodeURIComponent(playerId)}${instQs(queueInstance)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`Erro ${res.status}`)
    toast('Jogador removido da fila')
  } catch (err) {
    toast('Não deu para remover da fila', { tone: 'danger', message: err.message })
  }
}

async function kickFromSession(sessionId, playerId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/players/${encodeURIComponent(playerId)}/kick`, { method: 'POST' })
    if (!res.ok) throw new Error(`Erro ${res.status}`)
    toast('Jogador expulso', { message: 'A vaga liberou e a fila andou.' })
  } catch (err) {
    toast('Não deu para expulsar', { tone: 'danger', message: err.message })
  }
}

// ── QR dialog ─────────────────────────────────────────────────────────────────
// Enlarges a single totem's QR so an operator scanning with their own phone
// can't pick up a neighbouring card's code from the grid.

function openQrDialog(totem) {
  qrTitle.textContent = totem.name
  const img = new Image()
  img.alt = `QR Code de entrada do totem ${totem.name}`
  img.src = `${API}/${totem._id}/qr`
  qrBox.replaceChildren(img)
  qrDialog.showModal()
}
qrDialog.addEventListener('close', () => qrBox.replaceChildren())

// ── Operator actions ──────────────────────────────────────────────────────────

async function endAllSessions(totem) {
  const ok = await confirmAction({
    title: `Encerrar as partidas de "${totem.name}"?`,
    message: 'Todos que estão jogando no totem físico são desconectados e a fila avança.',
    confirmLabel: 'Encerrar todas',
  })
  if (!ok) return false
  try {
    await apiFetch(`${API}/${totem._id}/end-session`, { method: 'POST', body: '{}' })
    toast('Partidas encerradas', { message: 'Vagas liberadas. A fila avança sozinha.' })
    return true
  } catch (err) {
    toast('Não deu para encerrar', { tone: 'danger', message: err.message })
    return false
  }
}

async function deleteTotem(totem) {
  const ok = await confirmAction({
    title: `Excluir "${totem.name}"?`,
    message: 'As partidas em andamento terminam, a fila é apagada e os iframes nos sites param de funcionar. Não dá para desfazer.',
    confirmLabel: 'Excluir totem',
  })
  if (!ok) return
  try {
    await apiFetch(`${API}/${totem._id}`, { method: 'DELETE' })
    if (editingTotemId === totem._id) resetForm()
    await loadTotems()
    toast('Totem excluído', { message: totem.name })
  } catch (err) {
    toast('Não deu para excluir', { tone: 'danger', message: err.message })
  }
}

async function clearTotemQueue(totem) {
  const ok = await confirmAction({
    title: `Limpar a fila de "${totem.name}"?`,
    message: 'Quem está esperando perde o lugar. Quem já está jogando continua.',
    confirmLabel: 'Limpar fila',
  })
  if (!ok) return
  try {
    await apiFetch(`${API}/${totem._id}/queue/clear`, { method: 'POST' })
    await loadTotems()
    toast('Fila limpa', { message: totem.name })
  } catch (err) {
    toast('Não deu para limpar a fila', { tone: 'danger', message: err.message })
  }
}

// ── Totem form ────────────────────────────────────────────────────────────────

function openTotemDialog() {
  hideFormError()
  totemDialog.showModal()
  formName.focus()
}

function startEdit(totem) {
  editingTotemId       = totem._id
  formName.value       = totem.name
  formUrl.value        = totem.ip ? `${totem.ip}:${totem.udpPort}` : ''
  formGame.value       = totem.game ?? ''
  formGameConfig.value = totem.gameConfig ? JSON.stringify(totem.gameConfig, null, 2) : ''
  formMaxPlayers.value = String(totem.maxPlayers ?? 2)
  formDuration.value   = String(totem.sessionDurationMs ?? 1800000)
  formMaxQueue.value   = totem.maxQueueSize != null ? String(totem.maxQueueSize) : ''
  totemFormTitle.textContent = 'Editar totem'
  openTotemDialog()
}

function resetForm() {
  editingTotemId = null
  totemForm.reset()
  formMaxPlayers.value = '2'
  formDuration.value   = '1800000'
  totemFormTitle.textContent = 'Novo totem'
}

function newTotem() {
  resetForm()
  openTotemDialog()
}
$('btn-new-totem').addEventListener('click', newTotem)
document.querySelector('[data-action="new-totem"]').addEventListener('click', newTotem)
totemDialog.addEventListener('close', resetForm)

function showFormError(msg, field) {
  totemError.querySelector('span').textContent = msg
  totemError.hidden = false
  field?.focus()
}
function hideFormError() { totemError.hidden = true }

totemForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  hideFormError()
  const name              = formName.value.trim()
  const maxPlayers        = parseInt(formMaxPlayers.value, 10)
  const sessionDurationMs = parseInt(formDuration.value, 10)
  const maxQueueSize      = formMaxQueue.value.trim() ? parseInt(formMaxQueue.value, 10) : null
  const game    = formGame.value || null
  const hasAddr = Boolean(formUrl.value.trim())

  if (!name) return showFormError('Dê um nome ao totem.', formName)
  if (!game && !hasAddr) return showFormError('Escolha um jogo para incorporar ou informe o endereço do totem físico.', formGame)

  let ip = null, udpPort = null
  if (hasAddr) {
    const parsed = parseTotemUrl(formUrl.value)
    if (!parsed) return showFormError('Endereço inválido. Use IP:porta, ex.: 192.168.1.10:9001', formUrl)
    ;({ ip, udpPort } = parsed)
  }

  let gameConfig = null
  if (formGameConfig.value.trim()) {
    try {
      gameConfig = JSON.parse(formGameConfig.value)
      if (typeof gameConfig !== 'object' || Array.isArray(gameConfig) || gameConfig === null) throw new Error()
    } catch {
      return showFormError('A configuração do jogo precisa ser um objeto JSON, ex.: { "gameSpeed": 6 }', formGameConfig)
    }
  }

  const payload = { name, ip, udpPort, game, gameConfig, maxPlayers, sessionDurationMs, maxQueueSize }
  const wasEditing = Boolean(editingTotemId)

  btnSaveTotem.disabled = true
  try {
    if (wasEditing) {
      await apiFetch(`${API}/${editingTotemId}`, { method: 'PUT', body: JSON.stringify(payload) })
    } else {
      await apiFetch(API, { method: 'POST', body: JSON.stringify(payload) })
    }
    totemDialog.close('saved')
    await loadTotems()
    toast(wasEditing ? 'Totem atualizado' : 'Totem criado', { message: name })
  } catch (err) {
    showFormError(`Não foi possível salvar: ${err.message}`)
  } finally {
    btnSaveTotem.disabled = false
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Parses the totem address field into { ip, udpPort }. Accepts either:
 *   - "192.168.1.10:9001"                      (IP:porta)
 *   - "brickrush.dbpe.com.br:9101"              (domínio:porta)
 *   - "https://brickrush.dbpe.com.br:9101"      (URL completa com porta)
 * A URL sem porta explícita é inválida — a porta 443/80 implícita do
 * esquema NÃO é a porta UDP do jogo, então exigimos que venha escrita.
 */
function parseTotemUrl(input) {
  const trimmed = input.trim()

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed
    try { parsed = new URL(trimmed) } catch { return null }
    const ip = parsed.hostname
    const udpPort = parseInt(parsed.port, 10)
    if (!ip || !Number.isInteger(udpPort) || udpPort < 1 || udpPort > 65535) return null
    return { ip, udpPort }
  }

  // Bare "host:porta" — splits on the LAST colon so IPv6 hosts still work.
  const sep = trimmed.lastIndexOf(':')
  if (sep <= 0 || sep === trimmed.length - 1) return null
  const ip = trimmed.slice(0, sep)
  const udpPort = parseInt(trimmed.slice(sep + 1), 10)
  if (!ip || !Number.isInteger(udpPort) || udpPort < 1 || udpPort > 65535) return null
  return { ip, udpPort }
}

function formatDuration(ms) {
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} min`
  return `${Math.round(min / 60)}h`
}

// ── Embed (n→n) ───────────────────────────────────────────────────────────────
// Generates the <iframe> a site pastes. /embed/:id hands every page load its
// own instance, so the same snippet serves any number of visitors.

function embedUrl(totem) {
  const q = new URLSearchParams()
  if (!embedShowQr.checked) q.set('showqr', 'false')
  const pos = embedDialog.querySelector('input[name="embed-pos"]:checked')?.value
  if (embedShowQr.checked && pos && pos !== 'br') q.set('qrpos', pos)
  const qs = q.toString()
  return `${window.location.origin}/embed/${totem._id}${qs ? `?${qs}` : ''}`
}

function embedSnippet(totem) {
  const src  = embedUrl(totem)
  const name = escHtml(totem.name)
  if (embedResponsive.checked) {
    return `<div style="position:relative;width:100%;aspect-ratio:16/9;">\n` +
      `  <iframe src="${src}" title="${name}" allow="fullscreen; autoplay"\n` +
      `    style="position:absolute;inset:0;width:100%;height:100%;border:0;"></iframe>\n` +
      `</div>`
  }
  const w = Math.max(240, parseInt(embedWidth.value, 10) || 960)
  const h = Math.max(180, parseInt(embedHeight.value, 10) || 540)
  return `<iframe src="${src}" title="${name}" width="${w}" height="${h}"\n` +
    `  allow="fullscreen; autoplay" style="border:0;"></iframe>`
}

let previewTimer = null
function refreshEmbed({ reloadPreview = false } = {}) {
  if (!embedTotem) return
  embedWidth.disabled  = embedResponsive.checked
  embedHeight.disabled = embedResponsive.checked
  embedDialog.querySelectorAll('input[name="embed-pos"]').forEach(r => { r.disabled = !embedShowQr.checked })
  embedCode.textContent = embedSnippet(embedTotem)
  embedOpen.href = embedUrl(embedTotem)
  if (reloadPreview) {
    // Each preview load opens a real instance — debounce so toggling options
    // doesn't spawn a burst of them.
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => { embedPreview.src = embedUrl(embedTotem) }, 400)
  }
}

function openEmbedDialog(totem) {
  embedTotem = totem
  embedTotemName.textContent = `${totem.name} · ${totem.game}`
  refreshEmbed({ reloadPreview: true })
  embedDialog.showModal()
}

embedDialog.addEventListener('close', () => {
  clearTimeout(previewTimer)
  embedPreview.removeAttribute('src')   // closes the preview's instance
  embedTotem = null
})
for (const el of [embedResponsive, embedWidth, embedHeight]) el.addEventListener('input', () => refreshEmbed())
embedShowQr.addEventListener('change', () => refreshEmbed({ reloadPreview: true }))
embedDialog.querySelectorAll('input[name="embed-pos"]').forEach(r =>
  r.addEventListener('change', () => refreshEmbed({ reloadPreview: true })))

embedCopy.addEventListener('click', () =>
  copy(embedCode.textContent, 'Código copiado', 'Cole no HTML do site onde o jogo deve aparecer.'))

// ── Init ──────────────────────────────────────────────────────────────────────
loadGames()
loadTotems()
