// public/totem-entry.js
// Resolves the active session for the scanned totem and redirects to the play page.
//
// Flow:
//   1. Read ?id= from URL (totemId)
//   2. GET /api/totems/:id/session  → resolves or creates active session
//   3. Redirect to /play/:sessionId

const params  = new URLSearchParams(window.location.search)
const totemId = params.get('id')

const $loadingSub  = document.getElementById('loading-sub')
const $errorScreen = document.getElementById('error-screen')
const $loadScreen  = document.getElementById('loading')
const $errorMsg    = document.getElementById('error-msg')
const $retryBtn    = document.getElementById('retry-btn')

function showError(msg) {
  $loadScreen.style.display  = 'none'
  $errorScreen.style.display = 'flex'
  $errorMsg.textContent      = msg
}

async function resolveAndRedirect() {
  $loadScreen.style.display  = 'flex'
  $errorScreen.style.display = 'none'
  $loadingSub.textContent    = 'Conectando ao totem…'

  if (!totemId) {
    showError('QR Code inválido — ID do totem não encontrado.')
    return
  }

  try {
    $loadingSub.textContent = 'Buscando sessão…'

    const res  = await fetch(`/api/totems/${totemId}/session`)
    const data = await res.json()

    if (!res.ok) {
      showError(data.error ?? 'Totem não encontrado ou indisponível.')
      return
    }

    $loadingSub.textContent = 'Redirecionando…'

    // Short delay so the user sees the redirect message
    await new Promise(r => setTimeout(r, 400))

    window.location.replace(`/play/${data.sessionId}`)
  } catch {
    showError('Erro de conexão. Verifique sua internet e tente novamente.')
  }
}

$retryBtn.addEventListener('click', resolveAndRedirect)

// Run immediately
resolveAndRedirect()
