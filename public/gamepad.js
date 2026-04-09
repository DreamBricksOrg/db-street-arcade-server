// public/gamepad.js
// TASK-G8.2 — Touch Events + Input Dispatch
//
// Responsibilities:
//   - Captures touchstart/touchend on gamepad buttons
//   - Supports multi-touch (D-Pad + face button simultaneously)
//   - Prevents page scroll, zoom, and context menus on the gamepad area
//   - Emits { action, state } events via a callback
//   - Provides visual press feedback (CSS class toggling)
//
// Button IDs (must match HTML):
//   D-Pad : btn-up, btn-down, btn-left, btn-right
//   Face  : btn-A, btn-B, btn-X, btn-Y

/** Maps DOM element id → action name sent to the server */
const BUTTON_MAP = {
  'btn-up':    'dpad_up',
  'btn-down':  'dpad_down',
  'btn-left':  'dpad_left',
  'btn-right': 'dpad_right',
  'btn-A':     'btn_A',
  'btn-B':     'btn_B',
  'btn-X':     'btn_X',
  'btn-Y':     'btn_Y',
}

/**
 * Initialises the gamepad touch handling.
 *
 * @param {(payload: {action: string, state: 'pressed'|'released'}) => void} onInput
 *   Called whenever a button is pressed or released.
 * @returns {{ destroy: () => void }}  Call destroy() to remove all listeners.
 */
export function initGamepad(onInput) {
  const container = document.getElementById('gamepad')
  if (!container) throw new Error('Gamepad container #gamepad not found')

  // ── Prevent default browser gestures on the gamepad ────────────────────────
  const preventDefaults = (e) => e.preventDefault()

  container.addEventListener('touchstart',  preventDefaults, { passive: false })
  container.addEventListener('touchmove',   preventDefaults, { passive: false })
  container.addEventListener('touchend',    preventDefaults, { passive: false })
  container.addEventListener('touchcancel', preventDefaults, { passive: false })

  // ── Active touch tracking ──────────────────────────────────────────────────
  // Maps touchId → button element, so we fire 'released' on the correct button
  // even when the finger moves off before lifting.
  /** @type {Map<number, Element>} */
  const activeTouches = new Map()

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function getAction(el) {
    return BUTTON_MAP[el?.id] ?? null
  }

  function buttonAt(x, y) {
    // elementFromPoint uses viewport coords — works across all touch events
    const el = document.elementFromPoint(x, y)
    // Walk up to find a [data-btn] element in case of nested spans
    return el?.closest('[data-btn]') ?? null
  }

  function press(el) {
    const action = getAction(el)
    if (!action) return
    el.classList.add('pressed')
    onInput({ action, state: 'pressed' })
  }

  function release(el) {
    const action = getAction(el)
    if (!action) return
    el.classList.remove('pressed')
    onInput({ action, state: 'released' })
  }

  // ── Touch handlers ──────────────────────────────────────────────────────────

  function onTouchStart(e) {
    for (const touch of e.changedTouches) {
      const el = buttonAt(touch.clientX, touch.clientY)
      if (!el) continue
      activeTouches.set(touch.identifier, el)
      press(el)
    }
  }

  function onTouchEnd(e) {
    for (const touch of e.changedTouches) {
      const el = activeTouches.get(touch.identifier)
      if (!el) continue
      activeTouches.delete(touch.identifier)
      release(el)
    }
  }

  function onTouchCancel(e) {
    // Treat cancel the same as end (e.g. incoming call)
    onTouchEnd(e)
  }

  container.addEventListener('touchstart',  onTouchStart,  { passive: false })
  container.addEventListener('touchend',    onTouchEnd,    { passive: false })
  container.addEventListener('touchcancel', onTouchCancel, { passive: false })

  // ── Mouse fallback (for desktop testing) ────────────────────────────────────
  let mouseEl = null

  container.addEventListener('mousedown', (e) => {
    const el = e.target.closest('[data-btn]')
    if (!el) return
    mouseEl = el
    press(el)
  })

  window.addEventListener('mouseup', () => {
    if (mouseEl) { release(mouseEl); mouseEl = null }
  })

  // ── Destroy ─────────────────────────────────────────────────────────────────
  return {
    destroy() {
      container.removeEventListener('touchstart',  preventDefaults)
      container.removeEventListener('touchmove',   preventDefaults)
      container.removeEventListener('touchend',    preventDefaults)
      container.removeEventListener('touchcancel', preventDefaults)
      container.removeEventListener('touchstart',  onTouchStart)
      container.removeEventListener('touchend',    onTouchEnd)
      container.removeEventListener('touchcancel', onTouchCancel)
      activeTouches.clear()
    },
  }
}
