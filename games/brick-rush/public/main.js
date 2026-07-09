// games/brick-rush/public/main.js
// Boot: wires the SSE bridge (UDP packets from the backend) into the match
// state machine and runs the render loop.

import { createMatch } from './match.js'
import { draw } from './render.js'

const canvas = document.getElementById('game')
const ctx = canvas.getContext('2d')

const match = createMatch()

// Game config from the server's .env (rounds, timers)
fetch('/config')
  .then(r => r.json())
  .then(cfg => match.setConfig(cfg))
  .catch(() => console.warn('[config] usando defaults (server /config indisponível)'))

// ── SSE: packets from the backend via the local bridge ──────────────────────
const evtSource = new EventSource('/events')

evtSource.onmessage = (event) => {
  let data
  try { data = JSON.parse(event.data) } catch { return }
  const now = performance.now()

  switch (data.type) {
    case 'connected':
      console.log('[SSE] bridge conectada')
      return
    case 'init':
      console.log('[SSE] totem:', data.totemId)
      return
    case 'player_join':
      match.onPlayerJoin(data.pid, now)
      return
    case 'player_leave':
      match.onPlayerLeave(data.pid, now)
      return
    default:
      // gamepad input: { pid, a, s }
      if (data.pid && data.a !== undefined) {
        match.onInput(data.pid, data.a, data.s, now)
      }
  }
}

evtSource.onerror = () => console.warn('[SSE] desconectado — EventSource vai reconectar sozinho')

// ── Queue state polling (HUD + rotation K + maxPlayers) ─────────────────────
async function pollQueueState() {
  try {
    const res = await fetch('/queue-state')
    match.setQueueState(await res.json())
  } catch { /* bridge offline — keep last known */ }
}
pollQueueState()
setInterval(pollQueueState, 5000)

// ── Game loop ────────────────────────────────────────────────────────────────
let lastT = performance.now()

function frame(now) {
  const dt = Math.min(0.033, (now - lastT) / 1000) // clamp to 33ms
  lastT = now
  match.tick(now, dt)
  draw(ctx, match, now)
  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)
