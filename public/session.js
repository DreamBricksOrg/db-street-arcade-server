// public/session.js
// TASK-C9.2 — Sessão JS
//
// Responsibilities:
//   1. Read sessionId from URL: /play/<sessionId>
//   2. Generate or restore playerId (player-store.js: survives refresh and tab close)
//   3. Validate session via GET /api/sessions/:id
//   4. Manage visual states: loading → error | playing
//   5. Build WebSocket URL and hand off to ArcadeWsClient (C9.1)
//   6. Wire gamepad inputs to WebSocket send (C9.3)

import { ArcadeWsClient } from '/websocket-client.js'
import { initGamepad }    from '/gamepad.js'
import { getPlayer, setPlayer } from '/player-store.js'

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $loading    = document.getElementById('loading')
const $error      = document.getElementById('error-screen')
const $errorMsg   = document.getElementById('error-msg')
const $errorTitle = document.getElementById('error-title')
const $errorActs  = document.getElementById('error-actions')
const $play       = document.getElementById('play-screen')
const $sidLabel   = document.getElementById('sid-label')
const $conn       = document.getElementById('conn')

// ── Extract sessionId from URL ────────────────────────────────────────────────
const sessionId = location.pathname.split('/play/')[1]?.trim()

if (!sessionId) {
  showError('URL inválida — sessionId não encontrado.')
} else {
  boot(sessionId)
}

// ── Boot sequence ─────────────────────────────────────────────────────────────

async function boot(sid) {
  // 1. Validate session
  let session
  try {
    const res = await fetch(`/api/sessions/${sid}`)
    if (res.status === 404) return showError('Sessão não encontrada ou expirada.')
    if (!res.ok)            return showError(`Erro do servidor: ${res.status}`)
    session = await res.json()
  } catch (err) {
    return showError(`Falha de rede: ${err.message}`)
  }

  // Where "Jogar novamente" goes: the same totem AND the same iframe instance.
  const replayUrl = session.totemId
    ? `/play/totem?id=${session.totemId}` +
      (session.instanceId && session.instanceId !== 'default'
        ? `&instance=${encodeURIComponent(session.instanceId)}` : '')
    : null

  if (session.status === 'finished') {
    return showEnded(replayUrl)
  }

  // 2. Generate or restore playerId (C9.2: persists across refreshes)
  const storageKey = `sa_player_${sid}`
  let playerId = getPlayer(storageKey)
  if (!playerId) {
    playerId = 'p_' + crypto.randomUUID().slice(0, 8)
    setPlayer(storageKey, playerId)
  }

  // 3. Update page metadata
  document.title           = `Street Arcade — ${sid.slice(0, 8)}`
  $sidLabel.textContent    = sid.slice(0, 8) + '…'

  // 4. Transition to play screen
  $loading.style.display = 'none'
  $play.style.display    = 'flex'

  // 5. Build WebSocket URL
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl   = `${wsProto}//${location.host}/ws/game?sessionId=${sid}&playerId=${playerId}`

  // 6. Create WS client (C9.1)
  const ws = new ArcadeWsClient(wsUrl, {
    onOpen() {
      setConnected(true)
    },
    onClose(code) {
      setConnected(false)
      if (code === 1008) {
        // Policy violation — session ended
        destroyAll()
        showEnded(replayUrl)
      }
    },
    onError() {
      setConnected(false)
    },
    onMessage(data) {
      if (data.type === 'event') handleServerEvent(data)
    },
  })

  // 7. Init gamepad and wire inputs to WS (C9.3)
  const log     = document.getElementById('input-log')
  let logTimer  = null

  const gp = initGamepad((input) => {
    ws.send(input)

    // Visual debug feedback (G8.2 verify)
    if (log) {
      log.textContent = `${input.action} → ${input.state}`
      log.classList.add('show')
      clearTimeout(logTimer)
      logTimer = setTimeout(() => log.classList.remove('show'), 1200)
    }
  })


  function destroyAll() {
    ws.destroy()
    gp.destroy()
  }

  function handleServerEvent(data) {
    if (data?.data?.event === 'session_ended') {
      destroyAll()
      showEnded(replayUrl)
    }
  }
}

// ── Visual state helpers ──────────────────────────────────────────────────────

function setConnected(connected) {
  $conn.className   = 'db-badge db-badge--dot ' + (connected ? 'db-badge--success' : 'db-badge--warning db-badge--live')
  $conn.textContent = connected ? 'Conectado' : 'Reconectando…'
}

function showError(msg, title = 'Não deu para conectar') {
  $loading.style.display = 'none'
  $play.style.display    = 'none'
  $error.style.display   = 'flex'
  $errorMsg.textContent  = msg
  if ($errorTitle) $errorTitle.textContent = title
}

// "Game over" screen: session ended (death, kick or timeout). Offers a way
// back to the totem entry page, where the player joins the END of the queue.
function showEnded(replayUrl) {
  showError('Valeu por jogar! Quer outra rodada? Você entra no fim da fila.', 'Fim de jogo')
  if (!replayUrl || !$errorActs) return
  if (document.getElementById('play-again-btn')) return

  const btn = document.createElement('a')
  btn.id = 'play-again-btn'
  btn.className = 'db-btn db-btn--primary db-btn--lg db-btn--block'
  btn.href = replayUrl
  btn.textContent = 'Jogar novamente'
  $errorActs.appendChild(btn)
}
