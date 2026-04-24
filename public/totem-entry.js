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
}

function showQueue(pos) {
  $loadScreen.style.display  = 'none'
  $errorScreen.style.display = 'none'
  $queueScreen.style.display = 'flex'
  $queuePos.textContent      = pos
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

let pollTimer = null

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
      sessionStorage.setItem(`sa_player_${data.sessionId}`, playerId)
      window.location.replace(`/play/${data.sessionId}`)
      return
    }

    if (data.status === 'queue') {
      showQueue(data.position)
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
      showQueue(data.position)
      // Begins polling
      pollTimer = setTimeout(() => pollQueueStatus(playerId), 3000)
    }

  } catch (err) {
    showError('Falha de rede: ' + err.message)
  }
}

resolveAndRedirect()
