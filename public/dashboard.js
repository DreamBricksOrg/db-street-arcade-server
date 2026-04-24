// public/totems-tab.js
// Totem management tab — CRUD + session status + QR Code modal.
//
// Features:
//   - CRUD against /api/totems (now with maxPlayers, sessionDurationMs)
//   - Totem cards show live session status badge (polls every 15s)
//   - "QR Code" button opens permanent QR modal for each totem
//   - "Encerrar Sessão" button (with SweetAlert2 confirm) → POST /api/sessions/:id/end
//   - Emits 'totems:updated' event for other modules

const API = '/api/totems'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const totemList      = document.getElementById('totem-list')
const totemEmpty     = document.getElementById('totem-empty')
const formName       = document.getElementById('tf-name')
const formIp         = document.getElementById('tf-ip')
const formPort       = document.getElementById('tf-port')
const formMaxPlayers = document.getElementById('tf-max-players')
const formDuration   = document.getElementById('tf-duration')
const btnSaveTotem   = document.getElementById('btn-save-totem')
const btnCancelEdit  = document.getElementById('btn-cancel-edit')
const totemFormTitle = document.getElementById('totem-form-title')

// Modal refs
const btnNewTotem         = document.getElementById('btn-new-totem')
const totemFormModal      = document.getElementById('totemFormModal')
const totemFormModalClose = document.getElementById('totemFormModalClose')

// ── State ─────────────────────────────────────────────────────────────────────
let editingTotemId    = null
let sessionPollTimers = {}  // totemId → intervalId
let queuePollTimers   = {}  // totemId → intervalId

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (res.status === 204) return null
  return res.json()
}

// ── Load & Render ──────────────────────────────────────────────────────────────

export async function loadTotems() {
  // Clean up old polls
  Object.values(sessionPollTimers).forEach(clearInterval)
  Object.values(queuePollTimers).forEach(clearInterval)
  sessionPollTimers = {}
  queuePollTimers   = {}

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
    startSessionPoll(t, card)
    startQueuePoll(t, card)
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
          <span>👥 ${totem.maxPlayers ?? 2} jogadores</span>
          <span>⏱ ${durationLabel}</span>
          <span style="color: ${queueCount > 0 ? 'var(--accent)' : 'inherit'}; font-weight: ${queueCount > 0 ? '600' : 'normal'}">🧍‍♂️ Fila: ${queueCount}</span>
        </div>
        <div class="totem-session-status" data-status-area style="margin-top: 12px; margin-bottom: 0;">
          <span class="session-badge badge-loading">⏳ Verificando…</span>
        </div>

        <!-- Queue panel (hidden by default, toggled by button) -->
        <div data-queue-area style="margin-top: 12px; display: none;"></div>

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
      <div style="width: 140px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: white; padding: 10px; border-radius: 8px; border: 1px solid var(--border);">
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

  // Queue panel toggle — stored so startQueuePoll can reference it
  const queueArea   = card.querySelector('[data-queue-area]')
  const toggleBtn   = card.querySelector('.btn-queue-toggle')
  let   queueOpen   = false
  let   queueRender = null  // injected by startQueuePoll

  toggleBtn.addEventListener('click', () => {
    queueOpen = !queueOpen
    queueArea.style.display = queueOpen ? 'block' : 'none'
    toggleBtn.classList.toggle('btn-queue-toggle--active', queueOpen)
    toggleBtn.title = queueOpen ? 'Fechar Fila' : 'Ver Fila'
    if (queueOpen && queueRender) queueRender()  // refresh immediately on open
  })

  // Expose so startQueuePoll can inject the render fn
  card._injectQueueRender = (fn) => { queueRender = fn }

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

// ── Session Status Polling ─────────────────────────────────────────────────────

async function fetchSessionStatus(totemId) {
  try {
    const res  = await fetch(`${API}/${totemId}/session`)
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

function startSessionPoll(totem, card) {
  const render = async () => {
    const area = card.querySelector('[data-status-area]')
    if (!area) return

    const data = await fetchSessionStatus(totem._id)

    if (!data) {
      area.innerHTML = '<span class="session-badge badge-inactive">⚫ Sem Sessão</span>'
      return
    }

    const expiresStr = data.expiresAt ? new Date(data.expiresAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'

    area.innerHTML = `
      <span class="session-badge badge-active">🟢 Sessão Ativa</span>
      <span class="session-badge-info">Expira às ${expiresStr}</span>
      <button class="btn-end-session" data-sid="${escHtml(data.sessionId)}" data-totem-id="${escHtml(totem._id)}">
        Encerrar Sessão
      </button>
    `

    area.querySelector('.btn-end-session')?.addEventListener('click', async (e) => {
      const sid = e.currentTarget.dataset.sid
      await endSession(sid, totem.name)
      await render() // refresh immediately
    })
  }

  render()
  sessionPollTimers[totem._id] = setInterval(render, 15_000)
}

// ── Queue Panel ───────────────────────────────────────────────────────────────

function startQueuePoll(totem, card) {
  const render = async () => {
    const area = card.querySelector('[data-queue-area]')
    if (!area || area.style.display === 'none') return  // skip if panel is closed

    let data
    try {
      const res = await fetch(`${API}/${totem._id}/queue`)
      data = res.ok ? await res.json() : null
    } catch { data = null }

    if (!data) { area.innerHTML = ''; return }

    const { queue = [], sessionPlayers = [] } = data
    if (queue.length === 0 && sessionPlayers.length === 0) {
      area.innerHTML = `<div class="queue-panel"><div class="queue-panel-header"><span>Controle de Fila</span><span class="queue-count">Vazio</span></div></div>`
      return
    }

    const formatDeviceMeta = (meta) => {
      if (!meta || !meta.ua) return ''
      const ua = meta.ua.toLowerCase()
      let device = '🌐'
      
      if (ua.includes('iphone')) device = '📱 iPhone'
      else if (ua.includes('ipad')) device = 'Tablet'
      else if (ua.includes('android')) {
        device = '📱 Android'
        // Simple attempt to get model: usually after "Android X; "
        const parts = meta.ua.split(';')
        if (parts.length > 2 && ua.includes('android')) {
          const model = parts[2].split(')')[0].trim()
          if (model.length < 20) device += ` (${model})`
        }
      }
      else if (ua.includes('windows')) device = '💻 Win'
      else if (ua.includes('macintosh')) device = '💻 Mac'
      else if (ua.includes('linux')) device = '🐧 Linux'

      let browser = ''
      if (ua.includes('chrome')) browser = 'Chrome'
      else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'Safari'
      else if (ua.includes('firefox')) browser = 'Firefox'
      else if (ua.includes('edg')) browser = 'Edge'
      
      const screen = meta.screen ? ` · ${meta.screen}` : ''
      const lang = meta.lang ? ` · ${meta.lang.split('-')[0].toUpperCase()}` : ''
      
      return `<div class="queue-device-meta">${device}${browser ? ' · ' + browser : ''}${screen}${lang}</div>`
    }

    const playerRows = sessionPlayers.filter(p => p && (typeof p === 'string' || p.id || p._id)).map((p) => {
      const pid = (typeof p === 'string') ? p : (p.id || p._id)
      const pidStr = String(pid)
      const shortId = pidStr.length > 14 ? pidStr.slice(0, 14) : pidStr
      const metaHtml = formatDeviceMeta(p?.metadata)
      return `
        <div class="queue-row queue-row--playing">
          <span class="queue-pos">🎮</span>
          <div style="flex: 1; min-width: 0;">
            <div class="queue-pid" title="${escHtml(pidStr)}">${escHtml(shortId)}${pidStr.length > 14 ? '…' : ''}</div>
            ${metaHtml}
          </div>
          <button class="btn-kick" 
            data-totem-id="${escHtml(totem._id)}"
            data-session-id="${escHtml(String(data.sessionId || ''))}" 
            data-player-id="${escHtml(pidStr)}" 
            title="Expulsar da sessão">
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
      return `
        <div class="queue-row" data-player-id="${escHtml(pidStr)}">
          <span class="queue-pos">#${i + 1}</span>
          <div style="flex: 1; min-width: 0;">
            <div class="queue-pid" title="${escHtml(pidStr)}">${escHtml(shortId)}${pidStr.length > 14 ? '…' : ''}</div>
            ${metaHtml}
          </div>
          <button class="btn-kick" data-totem-id="${escHtml(totem._id)}" data-player-id="${escHtml(pidStr)}" title="Expulsar da fila">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            Expulsar
          </button>
        </div>`
    }).join('')

    area.innerHTML = `
      <div class="queue-panel">
        <div class="queue-panel-header">
          <span>Controle de Fila</span>
          <span class="queue-count">${sessionPlayers.length} jogando · ${queue.length} na fila</span>
        </div>
        ${playerRows}
        ${queue.length > 0 && sessionPlayers.length > 0 ? `<div class="queue-divider"></div>` : ''}
        ${queueRows}
      </div>
    `

    area.querySelectorAll('.btn-kick').forEach(btn => {
      btn.addEventListener('click', async () => {
        const pid = btn.dataset.playerId
        const tid = btn.dataset.totemId
        const sid = btn.dataset.sessionId
        
        if (sid) {
          await kickFromSession(sid, pid, totem.name)
        } else {
          await kickFromQueue(tid, pid, totem.name)
        }
        render()
      })
    })
  }

  // Inject render into the card so the toggle button can call it
  card._injectQueueRender?.(render)

  // Poll every 10s (only renders when panel is open)
  queuePollTimers[totem._id] = setInterval(render, 10_000)
}

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

// ── End Session ────────────────────────────────────────────────────────────────

async function endSession(sessionId, totemName) {
  const result = await Swal.fire({
    title:              `Encerrar sessão de "${escHtml(totemName)}"?`,
    text:               'A sessão atual será encerrada e uma nova será criada automaticamente.',
    icon:               'warning',
    showCancelButton:   true,
    confirmButtonColor: '#ef4444',
    cancelButtonColor:  '#64748b',
    confirmButtonText:  'Sim, encerrar',
    cancelButtonText:   'Cancelar',
    reverseButtons:     true,
    focusCancel:        true,
  })

  if (!result.isConfirmed) return

  try {
    const res = await fetch(`/api/sessions/${sessionId}/end`, { method: 'POST' })
    if (!res.ok) throw new Error(`Erro ${res.status}`)

    Swal.fire({
      title:             'Encerrada!',
      text:              'Nova sessão criada automaticamente.',
      icon:              'success',
      timer:             2000,
      showConfirmButton: false,
    })
  } catch (err) {
    showTotemError(`Erro ao encerrar sessão: ${err.message}`)
  }
}

// ── Form Logic ────────────────────────────────────────────────────────────────

function openTotemModal() {
  totemFormModal.style.display = 'flex'
  formName.focus()
}

function closeTotemModal() {
  totemFormModal.style.display = 'none'
  resetForm()
}

function startEdit(totem) {
  editingTotemId             = totem._id
  formName.value             = totem.name
  formIp.value               = totem.ip
  formPort.value             = totem.udpPort
  formMaxPlayers.value       = String(totem.maxPlayers ?? 2)
  formDuration.value         = String(totem.sessionDurationMs ?? 1800000)
  totemFormTitle.textContent = 'Editar Totem'
  openTotemModal()
}

function resetForm() {
  editingTotemId              = null
  formName.value              = ''
  formIp.value                = ''
  formPort.value              = ''
  formMaxPlayers.value        = '2'
  formDuration.value          = '1800000'
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
  const ip                = formIp.value.trim()
  const udpPort           = parseInt(formPort.value, 10)
  const maxPlayers        = parseInt(formMaxPlayers.value, 10)
  const sessionDurationMs = parseInt(formDuration.value, 10)

  if (!name || !ip || !udpPort) {
    showTotemError('Preencha nome, IP e porta.')
    return
  }

  btnSaveTotem.disabled    = true
  btnSaveTotem.textContent = 'Salvando...'

  try {
    if (editingTotemId) {
      await apiFetch(`${API}/${editingTotemId}`, {
        method: 'PUT',
        body:   JSON.stringify({ name, ip, udpPort, maxPlayers, sessionDurationMs }),
      })
    } else {
      await apiFetch(API, {
        method: 'POST',
        body:   JSON.stringify({ name, ip, udpPort, maxPlayers, sessionDurationMs }),
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
    confirmButtonColor: '#ef4444',
    cancelButtonColor:  '#64748b',
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
    confirmButtonColor: '#ef4444',
    cancelButtonColor:  '#64748b',
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
