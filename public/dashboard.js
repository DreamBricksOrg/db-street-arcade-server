// public/totems-tab.js
// Totem management tab — CRUD + session status + queue control.
//
// Features:
//   - CRUD against /api/totems (now with maxPlayers, sessionDurationMs)
//   - Totem cards show live session status badge (polls every 15s) and an
//     inline QR code image (no modal — the QR is always visible on the card)
//   - "Encerrar Sessão" button (with SweetAlert2 confirm) → POST /api/sessions/:id/end
//   - Emits 'totems:updated' event for other modules

const API = '/api/totems'

// Card-level status/meta icons share the hand-drawn stroke style used by the
// action buttons (stroke=currentColor, 2.2 weight, round caps), instead of
// emoji glyphs, so one icon vocabulary reads across the whole card.
const ICON_PLAYERS = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
const ICON_CLOCK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
const ICON_QUEUE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
const ICON_PHONE   = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>'
const ICON_DESKTOP = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>'
const ICON_SCREEN  = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>'
const ICON_CODE    = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>'
const ICON_GLOBE   = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const totemList      = document.getElementById('totem-list')
const totemEmpty     = document.getElementById('totem-empty')
const formName       = document.getElementById('tf-name')
const formUrl        = document.getElementById('tf-url')
const formMaxPlayers = document.getElementById('tf-max-players')
const formDuration   = document.getElementById('tf-duration')
const formMaxQueue   = document.getElementById('tf-max-queue')
const formGame       = document.getElementById('tf-game')
const formGameConfig = document.getElementById('tf-game-config')
const btnSaveTotem   = document.getElementById('btn-save-totem')
const btnCancelEdit  = document.getElementById('btn-cancel-edit')
const totemFormTitle = document.getElementById('totem-form-title')

// Modal refs
const btnNewTotem         = document.getElementById('btn-new-totem')
const totemFormModal      = document.getElementById('totemFormModal')
const totemFormModalClose = document.getElementById('totemFormModalClose')

// Queue modal refs
const queueModal         = document.getElementById('queueModal')
const queueModalClose    = document.getElementById('queueModalClose')
const queueModalTotemName = document.getElementById('queue-modal-totem-name')
const queueModalBody     = document.getElementById('queue-modal-body')
const queueInstanceSel   = document.getElementById('queue-instance')

// Embed dialog refs
const embedDialog     = document.getElementById('embedDialog')
const embedTotemName  = document.getElementById('embed-totem-name')
const embedPreview    = document.getElementById('embed-preview')
const embedResponsive = document.getElementById('embed-responsive')
const embedShowQr     = document.getElementById('embed-showqr')
const embedWidth      = document.getElementById('embed-width')
const embedHeight     = document.getElementById('embed-height')
const embedCode       = document.getElementById('embed-code')
const embedCopy       = document.getElementById('embed-copy')
const embedOpen       = document.getElementById('embed-open')
const toastEl         = document.getElementById('toast')

// QR lightbox refs
const qrLightbox      = document.getElementById('qrLightbox')
const qrLightboxClose = document.getElementById('qrLightboxClose')
const qrLightboxImg   = document.getElementById('qr-lightbox-img')
const qrLightboxName  = document.getElementById('qr-lightbox-name')

// ── State ─────────────────────────────────────────────────────────────────────
let editingTotemId    = null
let cardPollTimers    = {}  // totemId → intervalId (session status + queue count, shared poll)
let queueModalTotemId = null
let queueModalTimer   = null
let queueInstance     = 'default'   // instance shown in the queue modal
let embedTotem        = null

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

let toastTimer = null
function toast(msg) {
  if (!toastEl) return
  toastEl.textContent = msg
  toastEl.classList.add('is-visible')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2200)
}

// Embeddable games (folders in games/ with a public/index.html)
async function loadGames() {
  const games = await apiFetch('/api/games').catch(() => [])
  for (const g of games ?? []) {
    const opt = document.createElement('option')
    opt.value = g
    opt.textContent = g
    formGame.appendChild(opt)
  }
}

// ── Modal accessibility (focus trap + Escape) ────────────────────────────────
// Shared by every modal-overlay in the dashboard: traps Tab cycling inside the
// dialog, closes on Escape, and restores focus to whatever opened it.
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** @type {WeakMap<Element, { keydownHandler: (e: KeyboardEvent) => void, lastFocused: Element | null }>} */
const modalA11yState = new WeakMap()

function openModalA11y(modalEl, onClose, initialFocusEl) {
  const lastFocused = document.activeElement

  function keydownHandler(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return

    const focusable = Array.from(modalEl.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter(el => el.offsetParent !== null) // skip hidden elements
    if (focusable.length === 0) return

    const first = focusable[0]
    const last  = focusable[focusable.length - 1]

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  document.addEventListener('keydown', keydownHandler)
  modalA11yState.set(modalEl, { keydownHandler, lastFocused })

  // Focus the requested element (or the first focusable one) once visible.
  requestAnimationFrame(() => {
    const target = initialFocusEl ?? modalEl.querySelector(FOCUSABLE_SELECTOR)
    target?.focus()
  })
}

function closeModalA11y(modalEl) {
  const state = modalA11yState.get(modalEl)
  if (!state) return
  document.removeEventListener('keydown', state.keydownHandler)
  modalA11yState.delete(modalEl)
  // Restore focus to whatever triggered the modal (e.g. the card's "Editar" button).
  if (state.lastFocused instanceof HTMLElement) state.lastFocused.focus()
}

// ── Load & Render ──────────────────────────────────────────────────────────────

export async function loadTotems() {
  // Clean up old polls
  Object.values(cardPollTimers).forEach(clearInterval)
  cardPollTimers = {}

  totemList.innerHTML = ''
  const totems = await apiFetch(API).catch(() => [])

  if (!totems || totems.length === 0) {
    totemEmpty.style.display = 'flex'
    dispatchTotemsUpdated([])
    return []
  }

  totemEmpty.style.display = 'none'

  for (const t of totems) {
    const card = buildTotemCard(t)
    totemList.appendChild(card)
    startCardPoll(t, card)
  }

  dispatchTotemsUpdated(totems)
  return totems
}

function buildTotemCard(totem) {
  const durationLabel = formatDuration(totem.sessionDurationMs ?? 1800000)
  const entryUrl = `${window.location.origin}/play/totem?id=${totem._id}`
  const queueCount = totem.queueSize || 0
  const shortId = totem._id.slice(0, 8)
  const card = document.createElement('div')
  card.className  = 'totem-card'
  card.dataset.id = totem._id

  const hasPhysical = Boolean(totem.ip)
  const screens = totem.instances ?? { open: 0, online: 0 }

  card.innerHTML = `
    <div style="display: flex; gap: 20px; align-items: stretch;">
      <!-- Left Info Column -->
      <div style="flex: 1; display: flex; flex-direction: column;">
        <div class="totem-card-header">
          <span class="totem-card-name">${escHtml(totem.name)}</span>
          ${hasPhysical ? `<span class="totem-card-addr">${escHtml(totem.ip)}:${totem.udpPort}</span>` : ''}
        </div>

        <div class="totem-modes">
          ${hasPhysical ? '<span class="db-badge db-badge--success">Totem físico</span>' : ''}
          ${totem.game ? `<span class="db-badge db-badge--brand">Web · ${escHtml(totem.game)}</span>` : ''}
        </div>

        <!-- Totem ID row -->
        <div style="display: flex; align-items: center; gap: 6px; margin-top: 5px;">
          <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted);">ID</span>
          <code class="totem-id-chip" data-full-id="${escHtml(totem._id)}" title="Clique para copiar o ID completo" style="cursor:pointer;">${shortId}…</code>
        </div>

        <div class="totem-card-meta" style="margin-top: 8px;">
          <span>${ICON_PLAYERS} ${totem.maxPlayers ?? 2} jogadores</span>
          <span>${ICON_CLOCK} ${durationLabel}</span>
          <span data-queue-count style="color: ${queueCount > 0 ? 'var(--accent)' : 'inherit'}; font-weight: ${queueCount > 0 ? '600' : 'normal'}">${ICON_QUEUE} Fila: ${queueCount}</span>
          ${totem.game ? `<span class="totem-screens" data-screens data-live="${screens.online > 0}">${ICON_SCREEN} ${screensLabel(screens.online)}</span>` : ''}
        </div>
        <div class="totem-session-status" data-status-area style="margin-top: 12px; margin-bottom: 0;">
          <span class="session-badge badge-loading"><span class="mini-dot mini-dot--loading"></span> Verificando…</span>
        </div>

        <div style="flex: 1;"></div>
        <div class="totem-card-actions" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">
          ${totem.game ? `<button class="btn-icon btn-embed" title="Incorporar em um site" aria-label="Incorporar ${escHtml(totem.name)} em um site">${ICON_CODE} Incorporar</button>` : ''}
          <button class="btn-icon btn-queue-toggle" title="Ver Fila" aria-label="Ver fila do totem ${escHtml(totem.name)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            Fila
          </button>
          <button class="btn-icon btn-edit" title="Editar" aria-label="Editar totem ${escHtml(totem.name)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Editar
          </button>
          <button class="btn-icon btn-clear-queue" title="Limpar Fila" aria-label="Limpar fila de ${escHtml(totem.name)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3v4"></path><path d="M21 7h-8"></path><path d="M12 21H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h8"></path><path d="M12 7v14"></path></svg>
            Limpar Fila
          </button>
          <button class="btn-icon btn-delete" title="Excluir" aria-label="Excluir totem ${escHtml(totem.name)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            Excluir
          </button>
        </div>
      </div>
      ${hasPhysical ? `
      <!-- Right QR Code Column (physical totem only — web instances have their own QR) -->
      <div style="width: 140px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: var(--surface-card); padding: 10px; border-radius: var(--radius-md); border: 1px solid var(--border);">
         <img class="totem-card-qr-img" style="width:100%; height:auto; object-fit:contain;" src="${API}/${totem._id}/qr" alt="QR Code do Totem" title="Clique para ampliar" />
         <a class="totem-card-link" href="${entryUrl}" target="_blank" style="margin-top: 8px; font-size: 11px; text-decoration: none; color: var(--text-link); font-family: var(--font-mono); display: block; overflow: hidden; text-overflow: ellipsis; max-width: 100%;" title="${entryUrl}">Copiar Link</a>
      </div>` : ''}
    </div>
  `

  // Copy full ID on click
  card.querySelector('.totem-id-chip').addEventListener('click', function () {
    const fullId = this.dataset.fullId
    navigator.clipboard.writeText(fullId).then(() => {
      const orig = this.textContent
      this.textContent = 'Copiado!'
      this.style.color = 'var(--success)'
      setTimeout(() => { this.textContent = orig; this.style.color = '' }, 1800)
    })
  })

  card.querySelector('.btn-edit').addEventListener('click',   () => startEdit(totem))
  card.querySelector('.btn-delete').addEventListener('click', () => deleteTotem(totem._id, totem.name))
  card.querySelector('.btn-clear-queue').addEventListener('click', () => clearTotemQueue(totem._id, totem.name))
  card.querySelector('.btn-queue-toggle').addEventListener('click', () => openQueueModal(totem))
  card.querySelector('.btn-embed')?.addEventListener('click', () => openEmbedDialog(totem))
  card.querySelector('.totem-card-qr-img')?.addEventListener('click', () => openQrLightbox(totem))

  // Allow clicking the copy link to copy to clipboard
  const linkRef = card.querySelector('.totem-card-link')
  linkRef?.addEventListener('click', (e) => {
    e.preventDefault()
    navigator.clipboard.writeText(entryUrl).then(() => {
      const origText = linkRef.textContent
      linkRef.textContent = 'Copiado!'
      setTimeout(() => linkRef.textContent = origText, 2000)
    })
  })

  return card
}

// ── Card Polling ─────────────────────────────────────────────────────────────
// One session per player now: the card shows occupancy (X/N) instead of a
// single "active session", and "Encerrar Todas" resets every slot at once.
// Session status and queue count both come from the same /queue payload, so a
// single poll per card feeds both renders instead of two independent fetches
// hitting the same endpoint on separate timers.

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

function renderSessionStatus(totem, card, rows) {
  const area = card.querySelector('[data-status-area]')
  if (!area) return

  if (!rows) {
    area.innerHTML = '<span class="session-badge badge-inactive"><span class="mini-dot mini-dot--muted"></span> Indisponível</span>'
    return
  }

  const physical = rows.find(r => r.id === 'default') ?? { sessions: 0 }
  const web      = rows.filter(r => r.id !== 'default')
  const webPlayers = web.reduce((n, r) => n + r.sessions, 0)
  const total    = physical.sessions + webPlayers

  if (total === 0) {
    area.innerHTML = '<span class="session-badge badge-inactive"><span class="mini-dot mini-dot--muted"></span> Livre</span>'
    return
  }

  const parts = []
  if (totem.ip)  parts.push(`${physical.sessions}/${totem.maxPlayers ?? 2} no totem`)
  if (webPlayers) parts.push(`${webPlayers} na web`)
  area.innerHTML = `
    <span class="session-badge badge-active"><span class="mini-dot mini-dot--success"></span> ${parts.join(' · ')}</span>
    ${totem.ip && physical.sessions > 0 ? `<button class="btn-end-session" data-totem-id="${escHtml(totem._id)}" title="Encerra as sessões do totem físico">Encerrar Todas</button>` : ''}
  `
  area.querySelector('.btn-end-session')?.addEventListener('click', async () => {
    await endAllSessions(totem._id, totem.name)
    await pollCardState(totem, card) // refresh immediately
  })
}

function renderQueueCount(card, rows) {
  const countEl = card.querySelector('[data-queue-count]')
  if (!countEl || !rows) return

  const queueCount = rows.reduce((n, r) => n + r.queueSize, 0)
  countEl.innerHTML = `${ICON_QUEUE} Fila: ${queueCount}`
  countEl.style.color = queueCount > 0 ? 'var(--text-brand)' : 'inherit'
  countEl.style.fontWeight = queueCount > 0 ? '600' : 'normal'

  const screensEl = card.querySelector('[data-screens]')
  if (screensEl) {
    const online = rows.filter(r => r.id !== 'default' && r.online).length
    screensEl.innerHTML = `${ICON_SCREEN} ${screensLabel(online)}`
    screensEl.dataset.live = String(online > 0)
  }
}

async function pollCardState(totem, card) {
  const rows = await fetchTotemState(totem._id)
  renderSessionStatus(totem, card, rows)
  renderQueueCount(card, rows)
}

function startCardPoll(totem, card) {
  pollCardState(totem, card)
  cardPollTimers[totem._id] = setInterval(() => pollCardState(totem, card), 10_000)
}

// ── Queue Modal ───────────────────────────────────────────────────────────────

function formatDeviceMeta(meta) {
  if (!meta) return ''

  let deviceIcon = ICON_GLOBE
  let deviceText = 'Desconhecido'
  if (meta.ua) {
    const ua = meta.ua.toLowerCase()

    if (ua.includes('iphone')) { deviceIcon = ICON_PHONE; deviceText = 'iPhone' }
    else if (ua.includes('ipad')) { deviceIcon = ICON_PHONE; deviceText = 'iPad' }
    else if (ua.includes('android')) {
      deviceIcon = ICON_PHONE
      deviceText = 'Android'
      const parts = meta.ua.split(';')
      if (parts.length > 2) {
        const model = parts[2].split(')')[0].trim()
        if (model.length < 20) deviceText += ` (${model})`
      }
    }
    else if (ua.includes('windows'))   { deviceIcon = ICON_DESKTOP; deviceText = 'Windows' }
    else if (ua.includes('macintosh')) { deviceIcon = ICON_DESKTOP; deviceText = 'Mac' }
    else if (ua.includes('linux'))     { deviceIcon = ICON_DESKTOP; deviceText = 'Linux' }

    let browser = ''
    if (ua.includes('edg'))      browser = 'Edge'
    else if (ua.includes('chrome'))   browser = 'Chrome'
    else if (ua.includes('firefox'))  browser = 'Firefox'
    else if (ua.includes('safari'))   browser = 'Safari'

    if (browser) deviceText += ` · ${browser}`
  }

  const ip   = meta.ip ? ` · ${ICON_GLOBE} ${escHtml(meta.ip)}` : ''
  const lang = meta.lang ? ` · ${escHtml(meta.lang.split('-')[0].toUpperCase())}` : ''

  return `<div class="queue-device-meta">${deviceIcon} ${escHtml(deviceText)}${ip}${lang}</div>`
}

async function renderQueueModal(totem) {
  let data
  try {
    const res = await fetch(`${API}/${totem._id}/queue${instQs(queueInstance)}`)
    data = res.ok ? await res.json() : null
  } catch { data = null }

  if (!data) {
    queueModalBody.innerHTML = '<p style="font-size:13px; color: var(--text-muted);">Erro ao carregar a fila.</p>'
    return
  }

  const { queue = [], sessions = [], maxQueueSize = null } = data
  const queueCapLabel = maxQueueSize ? ` / ${maxQueueSize}` : ''

  if (queue.length === 0 && sessions.length === 0) {
    queueModalBody.innerHTML = `<div class="queue-panel"><div class="queue-panel-header"><span>Controle de Fila</span><span class="queue-count">Vazio${queueCapLabel ? ' · limite' + queueCapLabel : ''}</span></div></div>`
    return
  }

  // One row per live session (each player owns their own session now)
  const playerRows = sessions.map((s) => {
    const pidStr = String(s.playerId)
    const shortId = pidStr.length > 14 ? pidStr.slice(0, 14) : pidStr
    const metaHtml = formatDeviceMeta(s.metadata)
    const badge = s.status === 'active'
      ? '<span class="mini-dot mini-dot--success"></span>'
      : '<span class="mini-dot mini-dot--loading"></span>'
    const shortSid = String(s.sessionId).slice(0, 8)
    return `
      <div class="queue-row queue-row--playing">
        <span class="queue-pos">${badge}</span>
        <div style="flex: 1; min-width: 0;">
          <div class="queue-pid" title="${escHtml(pidStr)}">${escHtml(shortId)}${pidStr.length > 14 ? '…' : ''}</div>
          ${metaHtml}
          <div class="queue-device-meta" title="${escHtml(String(s.sessionId))}">🆔 sessão ${escHtml(shortSid)}… · ${s.status === 'active' ? 'jogando' : 'reservada'}</div>
        </div>
        <button class="btn-kick"
          data-session-id="${escHtml(String(s.sessionId))}"
          data-player-id="${escHtml(pidStr)}"
          title="Encerrar a sessão deste jogador">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Expulsar
        </button>
      </div>`
  }).join('')

  const queueRows = queue.filter(item => item && (typeof item === 'string' || item.id || item._id)).map((item, i) => {
    const pid = (typeof item === 'string') ? item : (item.id || item._id)
    const pidStr = String(pid)
    const shortId = pidStr.length > 14 ? pidStr.slice(0, 14) : pidStr
    const metaHtml = formatDeviceMeta(item?.metadata)

    // Heartbeat TTL: null = no Redis, -2 = expired/missing (ghost), -1 = no TTL, else seconds left.
    const ttl = item?.heartbeatTtl
    const isGhost = typeof ttl === 'number' && (ttl === -2 || ttl < 15)
    const ghostHtml = isGhost
      ? `<div class="queue-device-meta" style="color: var(--danger);">⚠️ ${ttl < 0 ? 'inativo' : `expira em ${ttl}s`}</div>`
      : ''

    const eta = item?.estimatedWaitMs
    const etaHtml = eta ? `<div class="queue-device-meta">⏱ ~${Math.max(1, Math.ceil(eta / 60000))} min</div>` : ''

    return `
      <div class="queue-row" data-player-id="${escHtml(pidStr)}">
        <span class="queue-pos">#${i + 1}</span>
        <div style="flex: 1; min-width: 0;">
          <div class="queue-pid" title="${escHtml(pidStr)}">${escHtml(shortId)}${pidStr.length > 14 ? '…' : ''}</div>
          ${metaHtml}
          ${etaHtml}
          ${ghostHtml}
        </div>
        <button class="btn-kick" data-totem-id="${escHtml(totem._id)}" data-player-id="${escHtml(pidStr)}" title="Remover da fila">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Expulsar
        </button>
      </div>`
  }).join('')

  queueModalBody.innerHTML = `
    <div class="queue-panel">
      <div class="queue-panel-header">
        <span>Controle de Fila</span>
        <span class="queue-count">${sessions.length} jogando · ${queue.length}${queueCapLabel} na fila</span>
      </div>
      ${playerRows}
      ${queue.length > 0 && sessions.length > 0 ? `<div class="queue-divider"></div>` : ''}
      ${queueRows}
    </div>
  `

  queueModalBody.querySelectorAll('.btn-kick').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.playerId
      const tid = btn.dataset.totemId
      const sid = btn.dataset.sessionId

      if (sid) {
        await kickFromSession(sid, pid, totem.name)
      } else {
        await kickFromQueue(tid, pid, totem.name)
      }
      renderQueueModal(totem)
    })
  })
}

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
  queueInstanceSel.closest('.queue-instance-bar').style.display = options.length > 1 ? '' : 'none'
}

let queueModalTotem = null
queueInstanceSel?.addEventListener('change', () => {
  queueInstance = queueInstanceSel.value
  if (queueModalTotem) renderQueueModal(queueModalTotem)
})

async function openQueueModal(totem) {
  queueModalTotemId = totem._id
  queueModalTotem   = totem
  queueInstance     = totem.ip ? 'default' : null
  queueModalTotemName.textContent = totem.name
  queueModal.style.display = 'flex'
  await refreshInstanceOptions(totem)
  renderQueueModal(totem)

  clearInterval(queueModalTimer)
  queueModalTimer = setInterval(async () => {
    await refreshInstanceOptions(totem)
    renderQueueModal(totem)
  }, 5_000)
  openModalA11y(queueModal, closeQueueModal)
}

function closeQueueModal() {
  queueModal.style.display = 'none'
  queueModalTotemId = null
  queueModalTotem   = null
  clearInterval(queueModalTimer)
  queueModalTimer = null
  closeModalA11y(queueModal)
}

queueModalClose?.addEventListener('click', closeQueueModal)
queueModal?.addEventListener('click', (e) => {
  if (e.target === queueModal) closeQueueModal()
})

// ── QR Lightbox ───────────────────────────────────────────────────────────────
// Enlarges a single totem's QR over a darkened, blurred backdrop so an
// operator scanning with their own phone can't accidentally pick up a
// neighboring totem's code from the card grid.

function openQrLightbox(totem) {
  qrLightboxName.textContent = totem.name
  qrLightboxImg.src = `${API}/${totem._id}/qr`
  qrLightbox.style.display = 'flex'
  openModalA11y(qrLightbox, closeQrLightbox, qrLightboxClose)
}

function closeQrLightbox() {
  qrLightbox.style.display = 'none'
  qrLightboxImg.src = ''
  closeModalA11y(qrLightbox)
}

qrLightboxClose?.addEventListener('click', closeQrLightbox)
qrLightbox?.addEventListener('click', (e) => {
  if (e.target === qrLightbox) closeQrLightbox()
})

// ── Kick from Queue ───────────────────────────────────────────────────────────

async function kickFromQueue(totemId, playerId, totemName) {
  try {
    const res = await fetch(`${API}/${totemId}/queue/${encodeURIComponent(playerId)}${instQs(queueInstance)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`Erro ${res.status}`)
    Swal.fire({
      title:             'Jogador Expulso',
      text:              `O jogador foi removido da fila de "${totemName}".`,
      icon:              'success',
      timer:             1500,
      showConfirmButton: false,
    })
  } catch (err) {
    showTotemError(`Erro ao expulsar da fila: ${err.message}`)
  }
}

async function kickFromSession(sessionId, playerId, totemName) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/players/${encodeURIComponent(playerId)}/kick`, { method: 'POST' })
    if (!res.ok) throw new Error(`Erro ${res.status}`)
    Swal.fire({
      title:             'Jogador Expulso',
      text:              `O jogador foi removido da sessão de "${totemName}".`,
      icon:              'success',
      timer:             1500,
      showConfirmButton: false,
    })
  } catch (err) {
    showTotemError(`Erro ao expulsar da sessão: ${err.message}`)
  }
}

// ── End All Sessions (operator reset) ─────────────────────────────────────────

async function endAllSessions(totemId, totemName) {
  const result = await Swal.fire({
    title:              `Encerrar TODAS as sessões de "${escHtml(totemName)}"?`,
    text:               'Todos os jogadores atuais serão desconectados e a fila avançará.',
    icon:               'warning',
    showCancelButton:   true,
    confirmButtonColor: 'oklch(0.58 0.20 25)',
    cancelButtonColor:  'oklch(0.52 0.022 230)',
    confirmButtonText:  'Sim, encerrar',
    cancelButtonText:   'Cancelar',
    reverseButtons:     true,
    focusCancel:        true,
  })

  if (!result.isConfirmed) return

  try {
    const res = await fetch(`${API}/${totemId}/end-session`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    '{}',
    })
    if (!res.ok) throw new Error(`Erro ${res.status}`)

    Swal.fire({
      title:             'Encerradas!',
      text:              'Vagas liberadas — a fila avança automaticamente.',
      icon:              'success',
      timer:             2000,
      showConfirmButton: false,
    })
  } catch (err) {
    showTotemError(`Erro ao encerrar sessões: ${err.message}`)
  }
}

// ── Form Logic ────────────────────────────────────────────────────────────────

function openTotemModal() {
  totemFormModal.style.display = 'flex'
  openModalA11y(totemFormModal, closeTotemModal, formName)
}

function closeTotemModal() {
  totemFormModal.style.display = 'none'
  resetForm()
  closeModalA11y(totemFormModal)
}

function startEdit(totem) {
  editingTotemId             = totem._id
  formName.value             = totem.name
  formUrl.value              = totem.ip ? `${totem.ip}:${totem.udpPort}` : ''
  formGame.value             = totem.game ?? ''
  formGameConfig.value       = totem.gameConfig ? JSON.stringify(totem.gameConfig, null, 2) : ''
  formMaxPlayers.value       = String(totem.maxPlayers ?? 2)
  formDuration.value         = String(totem.sessionDurationMs ?? 1800000)
  formMaxQueue.value         = totem.maxQueueSize != null ? String(totem.maxQueueSize) : ''
  totemFormTitle.textContent = 'Editar Totem'
  openTotemModal()
}

function resetForm() {
  editingTotemId              = null
  formName.value              = ''
  formUrl.value               = ''
  formGame.value              = ''
  formGameConfig.value        = ''
  formMaxPlayers.value        = '2'
  formDuration.value          = '1800000'
  formMaxQueue.value          = ''
  totemFormTitle.textContent  = 'Novo Totem'
}

btnNewTotem?.addEventListener('click', () => {
  resetForm()
  openTotemModal()
})

totemFormModalClose?.addEventListener('click', closeTotemModal)
btnCancelEdit?.addEventListener('click', closeTotemModal)
totemFormModal?.addEventListener('click', (e) => {
  if (e.target === totemFormModal) closeTotemModal()
})

btnSaveTotem?.addEventListener('click', async () => {
  const name              = formName.value.trim()
  const maxPlayers        = parseInt(formMaxPlayers.value, 10)
  const sessionDurationMs = parseInt(formDuration.value, 10)
  const maxQueueSize      = formMaxQueue.value.trim() ? parseInt(formMaxQueue.value, 10) : null

  const game = formGame.value || null
  const hasAddr = Boolean(formUrl.value.trim())

  if (!name) {
    showTotemError('Dê um nome ao totem.')
    return
  }
  if (!game && !hasAddr) {
    showTotemError('Escolha um jogo para incorporar ou informe o endereço do totem físico.')
    return
  }

  let ip = null, udpPort = null
  if (hasAddr) {
    const parsed = parseTotemUrl(formUrl.value)
    if (!parsed) {
      showTotemError('Endereço inválido. Use IP:Porta, ex: 192.168.1.10:9001')
      return
    }
    ;({ ip, udpPort } = parsed)
  }

  let gameConfig = null
  if (formGameConfig.value.trim()) {
    try {
      gameConfig = JSON.parse(formGameConfig.value)
      if (typeof gameConfig !== 'object' || Array.isArray(gameConfig) || gameConfig === null) throw new Error()
    } catch {
      showTotemError('Configuração do jogo precisa ser um objeto JSON, ex: { "gameSpeed": 6 }')
      return
    }
  }

  const payload = { name, ip, udpPort, game, gameConfig, maxPlayers, sessionDurationMs, maxQueueSize }

  btnSaveTotem.disabled    = true
  btnSaveTotem.textContent = 'Salvando...'

  try {
    if (editingTotemId) {
      await apiFetch(`${API}/${editingTotemId}`, { method: 'PUT', body: JSON.stringify(payload) })
    } else {
      await apiFetch(API, { method: 'POST', body: JSON.stringify(payload) })
    }

    closeTotemModal()
    await loadTotems()
  } catch (err) {
    showTotemError(`Não foi possível salvar: ${err.message}`)
  } finally {
    btnSaveTotem.disabled    = false
    btnSaveTotem.textContent = 'Salvar Totem'
  }
})

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteTotem(id, name) {
  const result = await Swal.fire({
    title:              `Excluir "${escHtml(name)}"?`,
    text:               'Esta ação não pode ser desfeita.',
    icon:               'warning',
    showCancelButton:   true,
    confirmButtonColor: 'oklch(0.58 0.20 25)',
    cancelButtonColor:  'oklch(0.52 0.022 230)',
    confirmButtonText:  'Sim, excluir',
    cancelButtonText:   'Cancelar',
    reverseButtons:     true,
    focusCancel:        true,
  })

  if (!result.isConfirmed) return

  try {
    const res = await fetch(`${API}/${id}`, { method: 'DELETE' })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `Erro ${res.status}`)
    }

    if (editingTotemId === id) resetForm()
    await loadTotems()

    Swal.fire({
      title:             'Excluído!',
      text:              `O totem "${name}" foi removido.`,
      icon:              'success',
      timer:             1800,
      showConfirmButton: false,
    })
  } catch (err) {
    showTotemError(`Erro ao excluir: ${err.message}`)
  }
}

// ── Clear Queue ───────────────────────────────────────────────────────────────

async function clearTotemQueue(id, name) {
  const result = await Swal.fire({
    title:              `Limpar fila de "${escHtml(name)}"?`,
    text:               'Todos os jogadores na fila perderão suas vagas.',
    icon:               'warning',
    showCancelButton:   true,
    confirmButtonColor: 'oklch(0.58 0.20 25)',
    cancelButtonColor:  'oklch(0.52 0.022 230)',
    confirmButtonText:  'Sim, limpar',
    cancelButtonText:   'Cancelar',
    reverseButtons:     true,
    focusCancel:        true,
  })

  if (!result.isConfirmed) return

  try {
    const res = await fetch(`${API}/${id}/queue/clear`, { method: 'POST' })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `Erro ${res.status}`)
    }

    await loadTotems()

    Swal.fire({
      title:             'Fila Limpa!',
      text:              `A fila do totem "${name}" foi limpa.`,
      icon:              'success',
      timer:             1800,
      showConfirmButton: false,
    })
  } catch (err) {
    showTotemError(`Erro ao limpar fila: ${err.message}`)
  }
}

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
 * Returns null se o formato não bater com nenhum dos casos acima.
 */
function parseTotemUrl(input) {
  const trimmed = input.trim()

  // Full URL with scheme (http://, https://, udp://...)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let parsed
    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }
    const ip = parsed.hostname
    const udpPort = parseInt(parsed.port, 10)
    if (!ip || !Number.isInteger(udpPort) || udpPort < 1 || udpPort > 65535) return null
    return { ip, udpPort }
  }

  // Bare "host:porta" — host can be an IP or a plain domain name.
  // Splits on the LAST colon so IPv6 hosts (which contain colons) still work.
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

function showTotemError(msg) {
  const el = document.getElementById('totem-error')
  if (!el) return
  el.textContent   = msg
  el.style.display = 'block'
  setTimeout(() => { el.style.display = 'none' }, 3500)
}

function dispatchTotemsUpdated(totems) {
  window.dispatchEvent(new CustomEvent('totems:updated', { detail: { totems } }))
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

embedDialog?.addEventListener('close', () => {
  clearTimeout(previewTimer)
  embedPreview.removeAttribute('src')   // closes the preview's instance
  embedTotem = null
})
for (const el of [embedResponsive, embedWidth, embedHeight]) el?.addEventListener('input', () => refreshEmbed())
embedShowQr?.addEventListener('change', () => refreshEmbed({ reloadPreview: true }))
embedDialog?.querySelectorAll('input[name="embed-pos"]').forEach(r =>
  r.addEventListener('change', () => refreshEmbed({ reloadPreview: true })))

embedCopy?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(embedCode.textContent)
    toast('Código copiado — cole no HTML do site')
  } catch {
    toast('Não deu para copiar. Selecione o código e copie manualmente.')
  }
})

// ── Init ──────────────────────────────────────────────────────────────────────
loadGames()
loadTotems()
