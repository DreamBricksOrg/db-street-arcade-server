// public/qrcode-page.js
// TASK-Q7.1 — QR Code page logic for the operator panel.
//
// Responsibilities:
//   - Populates totem dropdown from /api/totems
//   - Creates sessions via POST /api/sessions (with totem + expiresInMs)
//   - Fetches and displays QR code image from GET /api/sessions/:id/qr
//   - Polls session status every 5s to update the status badge
//   - Lists active sessions from the server

const API        = '/api/sessions'
const TOTEMS_API = '/api/totems'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const btnCreate     = document.getElementById('btn-create')
const maxPlayers    = document.getElementById('max-players')
const totemSelect   = document.getElementById('totem-select')
const expiryPreset  = document.getElementById('expiry-preset')
const expiryCustom  = document.getElementById('expiry-custom')
const qrCard        = document.getElementById('qr-card')
const qrImg         = document.getElementById('qr-img')
const metaSid       = document.getElementById('meta-sid')
const metaExp       = document.getElementById('meta-exp')
const qrUrlText     = document.getElementById('qr-url-text')
const sessionStatus = document.getElementById('session-status')
const sessionList   = document.getElementById('session-list')
const emptyState    = document.getElementById('empty-state')
const toast         = document.getElementById('toast')

// ── State ─────────────────────────────────────────────────────────────────────
let currentSessionId = null
let pollTimer        = null
let cachedTotems     = []

// ── Totem Dropdown ────────────────────────────────────────────────────────────

async function loadTotemsDropdown() {
  try {
    const res    = await fetch(TOTEMS_API)
    cachedTotems = res.ok ? await res.json() : []
  } catch {
    cachedTotems = []
  }
  renderTotemOptions()
}

function renderTotemOptions() {
  totemSelect.innerHTML = '<option value="">— Selecione um totem —</option>'
  for (const t of cachedTotems) {
    const opt   = document.createElement('option')
    opt.value   = t._id
    opt.textContent = `${t.name}  (${t.ip}:${t.udpPort})`
    totemSelect.appendChild(opt)
  }
}

// Sync when the totems tab modifies the list
window.addEventListener('totems:updated', (e) => {
  cachedTotems = e.detail.totems ?? []
  renderTotemOptions()
})

// ── Expiry preset ─────────────────────────────────────────────────────────────

expiryPreset?.addEventListener('change', () => {
  if (expiryPreset.value === 'custom') {
    expiryCustom.style.display = 'block'
    expiryCustom.focus()
  } else {
    expiryCustom.style.display = 'none'
  }
})

function resolveExpiryMs() {
  if (expiryPreset.value === 'custom') {
    const mins = parseFloat(expiryCustom.value)
    if (!mins || mins <= 0) return undefined
    return Math.round(mins * 60 * 1000)
  }
  return expiryPreset.value ? Number(expiryPreset.value) : undefined
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToast(msg, type = 'success') {
  toast.textContent   = msg
  toast.className     = type
  toast.style.display = 'block'
  setTimeout(() => { toast.style.display = 'none' }, 3500)
}

function formatExpiry(isoDate) {
  if (!isoDate) return '—'
  const d = new Date(isoDate)
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function setStatusBadge(status) {
  sessionStatus.className = `status-badge status-${status}`
  const labels = { waiting: 'Aguardando', active: 'Ativo', finished: 'Encerrado' }
  sessionStatus.innerHTML = `<div class="dot-pulse"></div>${labels[status] ?? status}`
}

// ── Create session ─────────────────────────────────────────────────────────────

btnCreate.addEventListener('click', async () => {
  const totemId = totemSelect?.value
  if (!totemId) {
    showToast('Selecione um totem para continuar.', 'error')
    return
  }

  const totem = cachedTotems.find(t => t._id === totemId)
  if (!totem) {
    showToast('Totem não encontrado. Recarregue a página.', 'error')
    return
  }

  btnCreate.disabled  = true
  btnCreate.innerHTML = '<span class="spinner"></span> Criando...'

  try {
    const expiresInMs = resolveExpiryMs()

    const body = {
      maxPlayers: parseInt(maxPlayers.value, 10),
      totems: [{ id: totem._id, ip: totem.ip, udpPort: totem.udpPort }],
      ...(expiresInMs ? { expiresInMs } : {}),
    }

    const res = await fetch(API, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error ?? 'Falha ao criar sessão')
    }

    const session = await res.json()
    currentSessionId = session.sessionId

    await loadQrCode(session.sessionId)

    metaSid.textContent   = session.sessionId.slice(0, 8) + '…'
    metaExp.textContent   = formatExpiry(session.expiresAt)
    qrUrlText.textContent = session.playUrl
    setStatusBadge(session.status)

    qrCard.classList.add('visible')
    showToast('Sessão criada com sucesso!')

    clearInterval(pollTimer)
    pollTimer = setInterval(() => pollSession(session.sessionId), 5000)

    await loadSessions()

  } catch (err) {
    showToast(err.message, 'error')
  } finally {
    btnCreate.disabled  = false
    btnCreate.innerHTML = 'Criar Sessão + QR Code'
  }
})

// ── Load QR image ──────────────────────────────────────────────────────────────

async function loadQrCode(sessionId) {
  const res = await fetch(`${API}/${sessionId}/qr?format=dataurl`)
  if (!res.ok) return
  const data = await res.json()
  qrImg.src  = data.qr
}

// ── Poll session status ────────────────────────────────────────────────────────

async function pollSession(sessionId) {
  try {
    const res = await fetch(`${API}/${sessionId}`)
    if (!res.ok) { clearInterval(pollTimer); return }

    const data = await res.json()
    setStatusBadge(data.status)
    metaExp.textContent = formatExpiry(data.expiresAt)

    if (data.status === 'finished') {
      clearInterval(pollTimer)
      showToast('Sessão encerrada.', 'error')
    }

    await loadSessions()
  } catch { /* ignore network errors */ }
}

// ── List active sessions ───────────────────────────────────────────────────────

async function loadSessions() {
  sessionList.innerHTML = ''

  try {
    const res = await fetch(API)
    if (!res.ok) { emptyState.style.display = 'flex'; return }

    const sessions = await res.json()

    if (sessions.length === 0) { emptyState.style.display = 'flex'; return }

    emptyState.style.display = 'none'
    const labels = { waiting: 'Aguardando', active: 'Ativo', finished: 'Encerrado' }

    for (const s of sessions) {
      const displayStatus = labels[s.status] ?? s.status
      const card = document.createElement('div')
      card.className = 'session-card'

      if (s.sessionId === currentSessionId) {
        card.style.borderColor = 'var(--accent)'
      }

      card.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:10px;">
          <span class="status-badge status-${s.status}">
            <div class="dot-pulse"></div>${displayStatus}
          </span>
          <span class="session-card-id" style="font-family:monospace;">${s.sessionId.slice(0,8)}</span>
        </div>

        <div style="display:flex; gap: 15px; align-items: center;">
          <img src="/api/sessions/${s.sessionId}/qr" alt="QR Code" style="width: 70px; height: 70px; border-radius: 4px; border: 2px solid var(--border);" />

          <div style="flex: 1; display: flex; flex-direction: column; gap: 4px;">
            <div class="session-card-players" style="font-size: 0.9rem;">
              Jog: <strong>${(s.players ?? []).length}/${s.maxPlayers}</strong>
            </div>
            <div class="session-card-players" style="font-size: 0.9rem;">
              Totem: <strong style="font-family:monospace;">${s.totems?.length > 0 ? `${s.totems[0].ip}:${s.totems[0].udpPort}` : 'N/A'}</strong>
            </div>
            <div class="session-card-players" style="font-size: 0.9rem;">
              Exp: <strong>${formatExpiry(s.expiresAt)}</strong>
            </div>
          </div>
        </div>
      `

      card.addEventListener('click', () => openSessionModal(s, displayStatus))
      sessionList.appendChild(card)
    }

  } catch {
    emptyState.style.display = 'flex'
  }
}

// ── Session Modal ─────────────────────────────────────────────────────────────

function openSessionModal(s, displayStatus) {
  document.getElementById('modal-qr-img').src = `/api/sessions/${s.sessionId}/qr`
  document.getElementById('modal-meta-sid').textContent    = s.sessionId.slice(0, 16) + '...'
  document.getElementById('modal-meta-status').textContent = displayStatus

  const fmt = (d) => d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'N/A'

  let html = `
    <div style="display:grid; grid-template-columns: auto 1fr; gap: 8px 16px;">
      <div style="color:var(--text-muted)">Máx. Jogadores</div><div><strong>${s.maxPlayers}</strong></div>
      <div style="color:var(--text-muted)">Criado Em</div><div>${fmt(s.createdAt)}</div>
      <div style="color:var(--text-muted)">Expira Em</div><div>${fmt(s.expiresAt)}</div>
    </div>
  `

  html += `<div style="margin-top:20px; margin-bottom:8px; font-weight:700; color:var(--accent); font-size:12px; letter-spacing:1px; text-transform:uppercase;">Totens Vinculados</div>`
  if (s.totems?.length > 0) {
    s.totems.forEach(t => {
      html += `<div style="display:flex; justify-content:space-between; align-items:center; background:var(--surface); padding:10px 12px; border-radius:8px; margin-bottom:6px; border:1px solid var(--border);">
        <span style="font-size:13px;">${t.id || 'Sem ID'}</span>
        <span style="font-family:monospace; color:var(--success); font-size:13px;">${t.ip}:${t.udpPort}</span>
      </div>`
    })
  } else {
    html += `<div style="color:var(--text-muted); font-size:13px;">Nenhum totem vinculado.</div>`
  }

  html += `<div style="margin-top:20px; margin-bottom:8px; font-weight:700; color:var(--accent); font-size:12px; letter-spacing:1px; text-transform:uppercase;">Jogadores (${(s.players ?? []).length})</div>`
  if (s.players?.length > 0) {
    s.players.forEach(p => {
      const id = typeof p === 'object' ? p.id : p
      const at = typeof p === 'object' && p.connectedAt ? fmt(p.connectedAt) : ''
      html += `<div style="display:flex; justify-content:space-between; align-items:center; background:var(--surface); padding:10px 12px; border-radius:8px; margin-bottom:6px; border:1px solid var(--border);">
        <span style="font-family:monospace; font-size:13px;">${id}</span>
        <span style="font-size:11px; color:var(--text-muted);">${at}</span>
      </div>`
    })
  } else {
    html += `<div style="color:var(--text-muted); font-size:13px;">Nenhum jogador conectado ainda.</div>`
  }

  document.getElementById('modal-details').innerHTML = html
  document.getElementById('modal-btn-play').onclick  = () => window.open(`/play/${s.sessionId}`, '_blank')
  document.getElementById('sessionModal').classList.add('active')
}

// ── Modal close ───────────────────────────────────────────────────────────────
const modal    = document.getElementById('sessionModal')
const btnClose = document.getElementById('modalClose')

function closeModal() { modal?.classList.remove('active') }
btnClose?.addEventListener('click', closeModal)
modal?.addEventListener('click', e => { if (e.target === modal) closeModal() })

// ── Init ──────────────────────────────────────────────────────────────────────
loadTotemsDropdown()
loadSessions()
