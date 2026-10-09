// public/totem-entry.js
// Resolves the active session for the scanned totem and redirects to the play page.
// Optionally manages the queue logic.
//
// Flow:
//   1. Read ?id= from URL (totemId)
//   2. POST /api/totems/:id/queue/join
//   3. If 'play', redirect to /play/:sessionId
//   4. If 'queue', display queue UI and poll GET /api/totems/:id/queue/status

import { getPlayer, setPlayer } from '/player-store.js'
import { createTurnAlert } from '/turn-alert.js'

const params     = new URLSearchParams(window.location.search)
const totemId    = params.get('id')
// Embedded iframe instance (n→n). Absent = the physical totem ('default').
const instanceId = params.get('instance')
const instQs     = instanceId ? `instance=${encodeURIComponent(instanceId)}` : ''
const CLOSED_MSG = 'Essa tela foi fechada. Abra o jogo de novo no site e escaneie o QR novo.'

const $loadingSub  = document.getElementById('loading-sub')
const $errorScreen = document.getElementById('error-screen')
const $loadScreen  = document.getElementById('loading')
const $queueScreen = document.getElementById('queue-screen')
const $queuePos    = document.getElementById('queue-pos')
const $queueEta    = document.getElementById('queue-eta')
const $errorMsg    = document.getElementById('error-msg')
const $errorTitle  = document.getElementById('error-title')
const $retryBtn    = document.getElementById('retry-btn')
const $queueMe     = document.getElementById('queue-me')
const $queueNick   = document.getElementById('queue-nick')
const $queuePaused = document.getElementById('queue-paused')
const $notifyBtn   = document.getElementById('notify-btn')
const $notifyState = document.getElementById('notify-state')
const $called      = document.getElementById('called-screen')

const alert = createTurnAlert()
let waited = false   // true once the player has been in line (alert on call)

$notifyBtn.addEventListener('click', async () => {
  $notifyBtn.disabled = true
  const { notifications } = await alert.arm()
  $notifyBtn.hidden = true
  $notifyState.textContent = notifications
    ? 'Pronto: o celular vai vibrar, tocar e mostrar uma notificação.'
    : 'Pronto: o celular vai vibrar e tocar. Deixe esta tela aberta.'
})

$retryBtn.addEventListener('click', () => {
  window.location.reload()
})

function showError(msg, title = 'Não deu para entrar') {
  $loadScreen.style.display  = 'none'
  $queueScreen.style.display = 'none'
  $errorScreen.style.display = 'flex'
  $errorMsg.textContent      = msg
  $errorTitle.textContent    = title
  stopQueueEvents()
}

/** Slot ready: alert a player who waited, then open the controller. */
async function goPlay(sessionId, playerId) {
  stopQueueEvents()
  clearTimeout(pollTimer)
  setPlayer(`sa_player_${sessionId}`, playerId)
  if (waited) {
    $queueScreen.style.display = 'none'
    $called.style.display = 'flex'
    await alert.fire()
    await new Promise(r => setTimeout(r, 1500))
  }
  window.location.replace(`/play/${sessionId}`)
}

function showNickname(nickname) {
  if (!nickname) return
  $queueNick.textContent = nickname
  $queueMe.hidden = false
}

function formatEta(ms) {
  if (!ms || ms <= 0) return ''
  const totalMin = Math.ceil(ms / 60_000)
  if (totalMin < 1) return 'menos de 1 min'
  if (totalMin === 1) return '~1 min'
  return `~${totalMin} min`
}

function showQueue(pos, estimatedWaitMs, { nickname = null, paused = false } = {}) {
  waited = true
  showNickname(nickname)
  $queuePaused.hidden = !paused
  $loadScreen.style.display  = 'none'
  $errorScreen.style.display = 'none'
  $queueScreen.style.display = 'flex'
  // Queue moved: replay the bump so the change is felt, not just read.
  if ($queuePos.textContent !== String(pos)) {
    $queuePos.classList.remove('is-bump')
    void $queuePos.offsetWidth
    $queuePos.classList.add('is-bump')
  }
  $queuePos.textContent      = pos
  $queueEta.textContent      = estimatedWaitMs ? `espera ${formatEta(estimatedWaitMs)}` : ''
}

// Survives closing the tab for a few minutes (player-store.js): coming back
// to the same totem/instance resumes the same place in line.
async function getPlayerId() {
  const storageKey = `sa_queue_pid_${totemId}${instanceId ? `_${instanceId}` : ''}`
  let pid = getPlayer(storageKey)
  if (!pid) {
    pid = 'qp_' + crypto.randomUUID().slice(0, 8)
    setPlayer(storageKey, pid)
  }
  return pid
}

let pollTimer  = null
let eventSrc   = null

// SSE: pushed whenever this totem's queue changes (join/leave/dequeue/clear),
// so we re-check our status right away instead of waiting up to 3s for the
// next poll tick. Polling stays on as a fallback in case SSE drops.
function startQueueEvents(playerId) {
  if (eventSrc || !totemId) return
  try {
    eventSrc = new EventSource(`/api/totems/${totemId}/queue/events${instQs ? `?${instQs}` : ''}`)
    eventSrc.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.type !== 'queue_changed') return
      clearTimeout(pollTimer)
      pollQueueStatus(playerId)
    }
    eventSrc.onerror = () => {
      // Let the browser's built-in EventSource reconnection handle transient drops;
      // polling continues regardless, so this is just a latency hit, not a hard failure.
    }
  } catch {
    // EventSource not available — polling alone still works.
  }
}

function stopQueueEvents() {
  eventSrc?.close()
  eventSrc = null
}

async function pollQueueStatus(playerId) {
  try {
    const res = await fetch(`/api/totems/${totemId}/queue/status?playerId=${playerId}${instQs ? `&${instQs}` : ''}`)
    const data = await res.json()

    if (!res.ok) {
      if (res.status === 410) { showError(CLOSED_MSG); return }
      if (data.error === 'Not in queue') {
        // Did we get kicked? Or maybe the session opened and we lost connection?
        // Let's just try to join again
        resolveAndRedirect()
        return
      }
      showError('Não conseguimos atualizar sua posição. Tente de novo.')
      return
    }

    if (data.status === 'play') {
      await goPlay(data.sessionId, playerId)
      return
    }

    if (data.status === 'queue') {
      showQueue(data.position, data.estimatedWaitMs, data)
      startQueueEvents(playerId)
      clearTimeout(pollTimer)
      pollTimer = setTimeout(() => pollQueueStatus(playerId), 3000)
    }
  } catch (err) {
    showError('Problema de rede. ' + err.message)
  }
}

async function resolveAndRedirect() {
  $loadScreen.style.display  = 'flex'
  $errorScreen.style.display = 'none'
  $queueScreen.style.display = 'none'
  $loadingSub.textContent    = 'Conectando ao totem…'

  if (!totemId) {
    showError('QR Code inválido — ID do totem não encontrado.')
    return
  }

  try {
    $loadingSub.textContent = 'Verificando vagas…'

    const playerId = await getPlayerId()
    
    // Collect basic device metadata
    const metadata = {
      screen: `${window.screen.width}x${window.screen.height}`,
      ratio: window.devicePixelRatio,
      lang: navigator.language,
      plat: navigator.platform
    }

    const res = await fetch(`/api/totems/${totemId}/queue/join${instQs ? `?${instQs}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, metadata })
    })
    const data = await res.json()

    if (!res.ok) {
      if (res.status === 409 && data.error === 'Queue is full') {
        showError('A fila deste totem está cheia no momento. Tente novamente em alguns minutos.')
        return
      }
      if (res.status === 410) {
        showError(CLOSED_MSG)
        return
      }
      if (res.status === 423) {
        showError('O operador pausou este totem por alguns minutos. Tente de novo daqui a pouco.', 'Totem em pausa')
        return
      }
      if (res.status === 429) {
        showError('Muitas tentativas seguidas. Aguarde alguns segundos e tente de novo.')
        return
      }
      showError(res.status === 404
        ? 'Este QR não leva a nenhum totem ativo. Confira o código no totem ou no site.'
        : 'O totem não respondeu agora. Tente de novo em alguns segundos.')
      return
    }

    if (data.status === 'play') {
      $loadingSub.textContent = 'Redirecionando…'
      // Share playerId so session.js uses the same ID for WS connection
      setPlayer(`sa_player_${data.sessionId}`, playerId)
      await new Promise(r => setTimeout(r, 400))
      window.location.replace(`/play/${data.sessionId}`)
      return
    }

    if (data.status === 'queue') {
      showQueue(data.position, data.estimatedWaitMs, data)
      startQueueEvents(playerId)
      // Begins polling (fallback in case SSE is unavailable/drops)
      pollTimer = setTimeout(() => pollQueueStatus(playerId), 3000)
    }

  } catch (err) {
    showError('Falha de rede: ' + err.message)
  }
}

resolveAndRedirect()
