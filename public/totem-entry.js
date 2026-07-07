// public/totem-entry.js
// Resolves the active session for the scanned totem and redirects to the play page.
// Optionally manages the queue logic.
//
// Flow:
//   1. Read ?id= from URL (totemId)
//   2. POST /api/totems/:id/queue/join
//   3. If 'play', redirect to /play/:sessionId
//   4. If 'queue', display queue UI and poll GET /api/totems/:id/queue/status

const params  = new URLSearchParams(window.location.search)
const totemId = params.get('id')

const $loadingSub  = document.getElementById('loading-sub')
const $errorScreen = document.getElementById('error-screen')
const $loadScreen  = document.getElementById('loading')
const $queueScreen = document.getElementById('queue-screen')
const $queuePos    = document.getElementById('queue-pos')
const $queueEta    = document.getElementById('queue-eta')
const $errorMsg    = document.getElementById('error-msg')
const $retryBtn    = document.getElementById('retry-btn')

$retryBtn.addEventListener('click', () => {
  window.location.reload()
})

function showError(msg) {
  $loadScreen.style.display  = 'none'
  $queueScreen.style.display = 'none'
  $errorScreen.style.display = 'flex'
  $errorMsg.textContent      = msg
  stopQueueEvents()
}

function formatEta(ms) {
  if (!ms || ms <= 0) return ''
  const totalMin = Math.ceil(ms / 60_000)
  if (totalMin < 1) return 'menos de 1 min'
  if (totalMin === 1) return '~1 min'
  return `~${totalMin} min`
}

function showQueue(pos, estimatedWaitMs) {
  $loadScreen.style.display  = 'none'
  $errorScreen.style.display = 'none'
  $queueScreen.style.display = 'flex'
  $queuePos.textContent      = pos
  $queueEta.textContent      = estimatedWaitMs ? `Tempo estimado: ${formatEta(estimatedWaitMs)}` : ''
}

async function getPlayerId() {
  const storageKey = `sa_queue_pid_${totemId}`
  let pid = sessionStorage.getItem(storageKey)
  if (!pid) {
    pid = 'qp_' + crypto.randomUUID().slice(0, 8)
    sessionStorage.setItem(storageKey, pid)
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
    eventSrc = new EventSource(`/api/totems/${totemId}/queue/events`)
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
    const res = await fetch(`/api/totems/${totemId}/queue/status?playerId=${playerId}`)
    const data = await res.json()

    if (!res.ok) {
      if (data.error === 'Not in queue') {
        // Did we get kicked? Or maybe the session opened and we lost connection?
        // Let's just try to join again
        resolveAndRedirect()
        return
      }
      showError(data.error ?? 'Falha ao buscar status da fila.')
      return
    }

    if (data.status === 'play') {
      stopQueueEvents()
      sessionStorage.setItem(`sa_player_${data.sessionId}`, playerId)
      window.location.replace(`/play/${data.sessionId}`)
      return
    }

    if (data.status === 'queue') {
      showQueue(data.position, data.estimatedWaitMs)
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

    const res = await fetch(`/api/totems/${totemId}/queue/join`, {
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
      if (res.status === 429) {
        showError('Muitas tentativas seguidas. Aguarde alguns segundos e tente de novo.')
        return
      }
      showError(data.error ?? 'Totem não encontrado ou indisponível.')
      return
    }

    if (data.status === 'play') {
      $loadingSub.textContent = 'Redirecionando…'
      // Share playerId so session.js uses the same ID for WS connection
      sessionStorage.setItem(`sa_player_${data.sessionId}`, playerId)
      await new Promise(r => setTimeout(r, 400))
      window.location.replace(`/play/${data.sessionId}`)
      return
    }

    if (data.status === 'queue') {
      showQueue(data.position, data.estimatedWaitMs)
      startQueueEvents(playerId)
      // Begins polling (fallback in case SSE is unavailable/drops)
      pollTimer = setTimeout(() => pollQueueStatus(playerId), 3000)
    }

  } catch (err) {
    showError('Falha de rede: ' + err.message)
  }
}

resolveAndRedirect()
