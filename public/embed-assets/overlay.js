// public/embed-assets/overlay.js
// QR card injected by the backend over an embedded game. Reads its totem and
// instance from the page path (/embed/:totemId/:instanceId/), so each iframe
// shows the QR of ITS OWN instance — phones that scan it only control this
// visitor's game.
//
// URL params (forwarded from the iframe src):
//   showqr=false        hide the card entirely
//   qrpos=br|bl|tr|tl   corner (default br)
//   qrmin=true          start collapsed

(() => {
  const m = location.pathname.match(/^\/embed\/([^/]+)\/([^/]+)\//)
  if (!m) return
  const [, totemId, instanceId] = m
  const params = new URLSearchParams(location.search)
  if (params.get('showqr') === 'false') return

  const entryUrl = `${location.origin}/play/totem?id=${encodeURIComponent(totemId)}&instance=${encodeURIComponent(instanceId)}`
  const qrSrc    = `/api/totems/${encodeURIComponent(totemId)}/qr?instance=${encodeURIComponent(instanceId)}`
  const pos      = ['br', 'bl', 'tr', 'tl'].includes(params.get('qrpos')) ? params.get('qrpos') : 'br'
  const isTouch  = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 820

  const ICON_MIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>'
  const ICON_QR  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/></svg>'

  const root = document.createElement('aside')
  root.className = 'dbx' + (isTouch ? ' dbx--touch' : '')
  root.dataset.pos = pos
  root.setAttribute('aria-label', 'Entrar no jogo pelo celular')
  root.innerHTML = `
    <div class="dbx-card">
      <div class="dbx-head">
        <img src="/assets/brand/dreambricks-mark-blue.svg" alt="" />
        <p class="dbx-title">${isTouch ? 'Jogue com o celular' : 'Jogue pelo celular'}</p>
        <button class="dbx-min" type="button" aria-label="Recolher QR Code">${ICON_MIN}</button>
      </div>
      <a class="dbx-qr" href="${entryUrl}" target="_blank" rel="noopener" aria-label="Abrir o controle em uma nova aba">
        <img src="${qrSrc}" alt="QR Code para entrar no jogo" width="300" height="300" />
      </a>
      <p class="dbx-status" role="status" aria-live="polite"><span class="dbx-dot"></span><span class="dbx-status-text">Carregando…</span></p>
      <a class="dbx-phone" href="${entryUrl}" target="_blank" rel="noopener">Jogar neste celular</a>
    </div>
    <button class="dbx-pill" type="button" aria-label="Mostrar QR Code para jogar">${ICON_QR} Jogar pelo celular</button>
  `
  document.body.appendChild(root)

  const $status = root.querySelector('.dbx-status')
  const $text   = root.querySelector('.dbx-status-text')
  root.querySelector('.dbx-min').addEventListener('click', () => {
    root.classList.add('is-min')
    root.querySelector('.dbx-pill').focus()
  })
  root.querySelector('.dbx-pill').addEventListener('click', () => {
    root.classList.remove('is-min')
    root.querySelector('.dbx-min').focus()
  })
  if (params.get('qrmin') === 'true') root.classList.add('is-min')

  // Free slots / queue length of THIS instance
  async function refresh() {
    try {
      const res = await fetch('queue-state', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const { sessions = [], queue = [], maxPlayers = 0, paused = false } = await res.json()
      const free = Math.max(0, maxPlayers - sessions.length)
      if (paused) {
        $status.dataset.state = 'busy'
        $text.textContent = 'Em pausa, volta já'
      } else if (free > 0 && queue.length === 0) {
        $status.dataset.state = 'free'
        $text.textContent = free === 1 ? '1 vaga livre' : `${free} vagas livres`
      } else {
        $status.dataset.state = 'busy'
        $text.textContent = queue.length === 0 ? 'Partida cheia' : `${queue.length} na fila`
      }
    } catch {
      $status.dataset.state = ''
      $text.textContent = 'Reconectando…'
    }
  }
  refresh()
  setInterval(() => { if (!document.hidden) refresh() }, 5000)
})()
