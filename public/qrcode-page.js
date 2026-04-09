// public/qrcode-page.js
// TASK-Q7.1 — QR Code page logic for the operator panel.
//
// Responsibilities:
//   - Creates sessions via POST /api/sessions
//   - Fetches and displays QR code image from GET /api/sessions/:id/qr
//   - Polls session status every 5s to update the status badge
//   - Lists active sessions from the server

const API = '/api/sessions'

// ── DOM refs ─────────────────────────────────────────────────────────────────
const btnCreate     = document.getElementById('btn-create')
const maxPlayers    = document.getElementById('max-players')
const totemIp       = document.getElementById('totem-ip')
const totemPort     = document.getElementById('totem-port')
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function showToast(msg, type = 'success') {
  toast.textContent = msg
  toast.className   = type
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
  btnCreate.disabled   = true
  btnCreate.innerHTML  = '<span class="spinner"></span> Criando...'

  try {
    const body = {
      maxPlayers: parseInt(maxPlayers.value, 10),
      totems: [
        {
          id:      'totem-1',
          ip:      totemIp.value.trim() || '127.0.0.1',
          udpPort: parseInt(totemPort.value, 10) || 9001,
        },
      ],
    }

    const res  = await fetch(API, {
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

    // Display QR Code image from the dedicated endpoint
    await loadQrCode(session.sessionId)

    // Update metadata
    metaSid.textContent  = session.sessionId.slice(0, 8) + '…'
    metaExp.textContent  = formatExpiry(session.expiresAt)
    qrUrlText.textContent = session.playUrl
    setStatusBadge(session.status)

    qrCard.classList.add('visible')
    showToast('Sessão criada com sucesso!')

    // Start polling session status
    clearInterval(pollTimer)
    pollTimer = setInterval(() => pollSession(session.sessionId), 5000)

    // Refresh session list
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
  // Use the dataurl format so we can embed without CORS issues
  const res  = await fetch(`${API}/${sessionId}/qr?format=dataurl`)
  if (!res.ok) return
  const data = await res.json()
  qrImg.src  = data.qr
}

// ── Poll session status ────────────────────────────────────────────────────────

async function pollSession(sessionId) {
  try {
    const res = await fetch(`${API}/${sessionId}`)
    if (!res.ok) {
      clearInterval(pollTimer)
      return
    }
    const data = await res.json()
    setStatusBadge(data.status)
    metaExp.textContent = formatExpiry(data.expiresAt)

    if (data.status === 'finished') {
      clearInterval(pollTimer)
      showToast('Sessão encerrada.', 'error')
    }
  } catch { /* ignore network errors */ }
}

// ── List active sessions ───────────────────────────────────────────────────────

async function loadSessions() {
  // We don't have a GET /api/sessions list endpoint yet —
  // show only the current session if available
  sessionList.innerHTML = ''

  if (!currentSessionId) {
    emptyState.style.display = 'flex'
    return
  }

  try {
    const res  = await fetch(`${API}/${currentSessionId}`)
    if (!res.ok) {
      emptyState.style.display = 'flex'
      return
    }
    const s = await res.json()

    emptyState.style.display = 'none'

    const card = document.createElement('div')
    card.className = 'session-card'
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span class="status-badge status-${s.status}">
          <div class="dot-pulse"></div>${s.status}
        </span>
        <span class="session-card-id">${s.sessionId}</span>
      </div>
      <div class="session-card-players">
        Jogadores: <strong>${(s.players ?? []).length} / ${s.maxPlayers}</strong>
      </div>
      <div class="session-card-players">
        Expira às: <strong>${formatExpiry(s.expiresAt)}</strong>
      </div>
    `
    card.addEventListener('click', () => window.open(`/play/${s.sessionId}`, '_blank'))
    sessionList.appendChild(card)

  } catch {
    emptyState.style.display = 'flex'
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadSessions()
