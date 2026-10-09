// public/turn-alert.js
// "It's your turn" alert for the waiting screen. A called player has only
// QUEUE_RESERVE_MS (30s) to connect, so we try every channel the phone allows:
// vibration, a short chime, the tab title and a system notification.
//
// Browsers only allow sound, vibration and notification prompts after a tap,
// so arm() must run inside a click handler ("Me avise quando for a minha vez").
// fire() works without a tap afterwards (sticky activation).

export function createTurnAlert() {
  let audio = null
  let armed = false
  const originalTitle = document.title

  async function arm() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx) { audio = new Ctx(); await audio.resume() }
    } catch { audio = null }
    try { navigator.vibrate?.(60) } catch { /* unsupported */ }
    if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission() } catch { /* dismissed */ }
    }
    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('/sw.js') } catch { /* http or blocked */ }
    }
    armed = true
    return { notifications: 'Notification' in window && Notification.permission === 'granted' }
  }

  function chime() {
    if (!audio) return
    const t = audio.currentTime
    for (const [i, freq] of [880, 1175, 1568].entries()) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t + i * 0.16)
      gain.gain.exponentialRampToValueAtTime(0.35, t + i * 0.16 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.3)
      osc.connect(gain).connect(audio.destination)
      osc.start(t + i * 0.16)
      osc.stop(t + i * 0.16 + 0.32)
    }
  }

  async function notify() {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return
    const options = {
      body: 'Toque para abrir o controle. Você tem 30 segundos.',
      tag: 'sa-turn', renotify: true, requireInteraction: true,
      icon: '/assets/brand/dreambricks-mark-blue.svg',
      vibrate: [250, 120, 250, 120, 500],
    }
    try {
      const reg = await navigator.serviceWorker?.getRegistration()
      if (reg) return reg.showNotification('É a sua vez!', options)
      new Notification('É a sua vez!', options)   // desktop without SW
    } catch { /* Android needs the SW; nothing else to try */ }
  }

  /** Called the moment the player's slot is ready. */
  async function fire() {
    document.title = 'É a sua vez! · Street Arcade'
    try { navigator.vibrate?.([250, 120, 250, 120, 500]) } catch { /* unsupported */ }
    chime()
    await notify()
  }

  function reset() { document.title = originalTitle }

  return { arm, fire, reset, get armed() { return armed } }
}
