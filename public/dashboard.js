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
const ICON_GLOBE   = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const totemList      = document.getElementById('totem-list')
const totemEmpty     = document.getElementById('totem-empty')
const formName       = document.getElementById('tf-name')
const formUrl        = document.getElementById('tf-url')
const formMaxPlayers = document.getElementById('tf-max-players')
const formDuration   = document.getElementById('tf-duration')
const formMaxQueue   = document.getElementById('tf-max-queue')
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

// ── State ─────────────────────────────────────────────────────────────────────
let editingTotemId    = null
let cardPollTimers    = {}  // totemId → intervalId (session status + queue count, shared poll)
let queueModalTotemId = null
let queueModalTimer   = null

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (res.status === 204) return null
  return res.json()
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

  card.innerHTML = `
    <div style="display: flex; gap: 20px; align-items: stretch;">
      <!-- Left Info Column -->
      <div style="flex: 1; display: flex; flex-direction: column;">
        <div class="totem-card-header">
          <span class="totem-card-name">${escHtml(totem.name)}</span>
          <span class="totem-card-addr">${escHtml(totem.ip)}:${totem.udpPort}</span>
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
        </div>
        <div class="totem-session-status" data-status-area style="margin-top: 12px; margin-bottom: 0;">
          <span class="session-badge badge-loading"><span class="mini-dot mini-dot--loading"></span> Verificando…</span>
        </div>

        <div style="flex: 1;"></div>
        <div class="totem-card-actions" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">
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
      <!-- Right QR Code Column -->
      <div style="width: 140px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: white; padding: 10px; border-radius: 10px; border: 1px solid var(--border);">
         <img style="width:100%; height:auto; object-fit:contain;" src="${API}/${totem._id}/qr" alt="QR Code do Totem" />
         <a href="${entryUrl}" target="_blank" style="margin-top: 8px; font-size: 11px; text-decoration: none; color: var(--accent); font-family: monospace; display: block; overflow: hidden; text-overflow: ellipsis; max-width: 100%;" title="${entryUrl}">Copiar Link</a>
      </div>
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

  // Allow clicking the copy link to copy to clipboard
  const linkRef = card.querySelector('a')
  linkRef.addEventListener('click', (e) => {
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

async function fetchTotemState(totemId) {
  try {
    const res = await fetch(`${API}/${totemId}/queue`)
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

function renderSessionStatus(totem, card, data) {
  const area = card.querySelector('[data-status-area]')
  if (!area) return

  if (!data) {
    area.innerHTML = '<span class="session-badge badge-inactive"><span class="mini-dot mini-dot--muted"></span> Indisponível</span>'
    return
  }

  const { sessions = [], maxPlayers = totem.maxPlayers ?? 2 } = data
  const active   = sessions.filter(s => s.status === 'active').length
  const reserved = sessions.filter(s => s.status === 'reserved').length

  if (sessions.length === 0) {
    area.innerHTML = '<span class="session-badge badge-inactive"><span class="mini-dot mini-dot--muted"></span> Livre</span>'
    return
  }

  area.innerHTML = `
    <span class="session-badge badge-active"><span class="mini-dot mini-dot--success"></span> ${active}/${maxPlayers} jogando${reserved ? ` · ${reserved} reservado(s)` : ''}</span>
    <button class="btn-end-session" data-totem-id="${escHtml(totem._id)}">Encerrar Todas</button>
  `
  area.querySelector('.btn-end-session')?.addEventListener('click', async () => {
    await endAllSessions(totem._id, totem.name)
    await pollCardState(totem, card) // refresh immediately
  })
}

function renderQueueCount(card, data) {
  const countEl = card.querySelector('[data-queue-count]')
  if (!countEl || !data) return

  const queueCount = data.queue?.length ?? 0
  countEl.innerHTML = `${ICON_QUEUE} Fila: ${queueCount}`
  countEl.style.color = queueCount > 0 ? 'var(--accent)' : 'inherit'
  countEl.style.fontWeight = queueCount > 0 ? '600' : 'normal'
}

async function pollCardState(totem, card) {
  const data = await fetchTotemState(totem._id)
  renderSessionStatus(totem, card, data)
  renderQueueCount(card, data)
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
    const res = await fetch(`${API}/${totem._id}/queue`)
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

function openQueueModal(totem) {
  queueModalTotemId = totem._id
  queueModalTotemName.textContent = totem.name
  queueModal.style.display = 'flex'
  renderQueueModal(totem)

  clearInterval(queueModalTimer)
  queueModalTimer = setInterval(() => renderQueueModal(totem), 5_000)
  openModalA11y(queueModal, closeQueueModal)
}

function closeQueueModal() {
  queueModal.style.display = 'none'
  queueModalTotemId = null
  clearInterval(queueModalTimer)
  queueModalTimer = null
  closeModalA11y(queueModal)
}

queueModalClose?.addEventListener('click', closeQueueModal)
queueModal?.addEventListener('click', (e) => {
  if (e.target === queueModal) closeQueueModal()
})

// ── Kick from Queue ───────────────────────────────────────────────────────────

async function kickFromQueue(totemId, playerId, totemName) {
  try {
    const res = await fetch(`${API}/${totemId}/queue/${encodeURIComponent(playerId)}`, { method: 'DELETE' })
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
  formUrl.value              = `${totem.ip}:${totem.udpPort}`
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

  if (!name || !formUrl.value.trim()) {
    showTotemError('Preencha nome e URL do totem.')
    return
  }

  const parsed = parseTotemUrl(formUrl.value)
  if (!parsed) {
    showTotemError('URL inválida. Use o formato IP:Porta, ex: 192.168.1.10:9001')
    return
  }
  const { ip, udpPort } = parsed

  btnSaveTotem.disabled    = true
  btnSaveTotem.textContent = 'Salvando...'

  try {
    if (editingTotemId) {
      await apiFetch(`${API}/${editingTotemId}`, {
        method: 'PUT',
        body:   JSON.stringify({ name, ip, udpPort, maxPlayers, sessionDurationMs, maxQueueSize }),
      })
    } else {
      await apiFetch(API, {
        method: 'POST',
        body:   JSON.stringify({ name, ip, udpPort, maxPlayers, sessionDurationMs, maxQueueSize }),
      })
    }

    closeTotemModal()
    await loadTotems()
  } catch {
    showTotemError('Erro ao salvar totem.')
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

// ── Init ──────────────────────────────────────────────────────────────────────
loadTotems()
