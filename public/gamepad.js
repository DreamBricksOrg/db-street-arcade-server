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
 * Keyboard scheme: arrow keys drive the D-Pad, I/J/K/L drive the ABXY
 * diamond in the same spatial layout (I=top/Y, J=left/X, L=right/B, K=bottom/A).
 * Lets a keyboard user hold multiple buttons at once, same as multi-touch.
 */
const KEY_TO_BUTTON_ID = {
  ArrowUp:    'btn-up',
  ArrowDown:  'btn-down',
  ArrowLeft:  'btn-left',
  ArrowRight: 'btn-right',
  KeyI: 'btn-Y',
  KeyJ: 'btn-X',
  KeyL: 'btn-B',
  KeyK: 'btn-A',
}

/** Haptic feedback duration in ms (increase for stronger feel) */
const VIBRATION_DURATION = 40;

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
    if (navigator.vibrate) navigator.vibrate(VIBRATION_DURATION) // Tactical buzz
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
      activeTouches.set(touch.identifier, el)
      if (el) press(el)
    }
  }

  // touchmove can fire far faster than the display refreshes. buttonAt() calls
  // elementFromPoint(), which forces a synchronous layout — doing that per raw
  // event (possibly per touch) risks dropped frames during fast multi-touch
  // play. Coalesce to the latest position per touch and resolve once a frame.
  /** @type {Map<number, {x: number, y: number}>} */
  const pendingMoves = new Map()
  let moveRafId = null

  function flushPendingMoves() {
    moveRafId = null
    for (const [touchId, { x, y }] of pendingMoves) {
      if (!activeTouches.has(touchId)) continue

      const currentEl = activeTouches.get(touchId)
      const newEl = buttonAt(x, y)

      if (newEl !== currentEl) {
        if (currentEl) release(currentEl)
        if (newEl) press(newEl)
        activeTouches.set(touchId, newEl)
      }
    }
    pendingMoves.clear()
  }

  function onTouchMove(e) {
    for (const touch of e.changedTouches) {
      // If we aren't tracking this touch, ignore it
      if (!activeTouches.has(touch.identifier)) continue
      pendingMoves.set(touch.identifier, { x: touch.clientX, y: touch.clientY })
    }
    if (pendingMoves.size > 0 && moveRafId === null) {
      moveRafId = requestAnimationFrame(flushPendingMoves)
    }
  }

  function onTouchEnd(e) {
    for (const touch of e.changedTouches) {
      pendingMoves.delete(touch.identifier) // drop any move still queued for this frame
      if (!activeTouches.has(touch.identifier)) continue

      const el = activeTouches.get(touch.identifier)
      if (el) release(el)
      activeTouches.delete(touch.identifier)
    }
  }

  function onTouchCancel(e) {
    onTouchEnd(e)
  }

  container.addEventListener('touchstart',  onTouchStart,  { passive: false })
  container.addEventListener('touchmove',   onTouchMove,   { passive: false })
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

  // ── Keyboard support ─────────────────────────────────────────────────────────
  // Two independent paths so both AT users and keyboard players are covered:
  //   1. Global key scheme (arrows + IJKL) — supports holding multiple buttons
  //      at once, tracked by e.code like activeTouches tracks touch identifiers.
  //   2. Space/Enter on a focused button — standard button activation for
  //      anyone tabbing through the controls (screen readers, switch access).
  /** @type {Map<string, Element>} */
  const activeKeys = new Map()

  function onKeyDown(e) {
    const mappedId = KEY_TO_BUTTON_ID[e.code]
    if (mappedId) {
      if (e.repeat) return // ignore OS key-repeat; button is already "held"
      const el = document.getElementById(mappedId)
      if (!el || activeKeys.has(e.code)) return
      e.preventDefault() // stop arrow-key page scroll
      activeKeys.set(e.code, el)
      press(el)
      return
    }

    // Focused-button activation (Space/Enter)
    if (e.key === ' ' || e.key === 'Enter') {
      const el = e.target.closest?.('[data-btn]')
      if (!el || e.repeat) return
      e.preventDefault()
      press(el)
    }
  }

  function onKeyUp(e) {
    const mappedId = KEY_TO_BUTTON_ID[e.code]
    if (mappedId) {
      const el = activeKeys.get(e.code)
      if (el) release(el)
      activeKeys.delete(e.code)
      return
    }

    if (e.key === ' ' || e.key === 'Enter') {
      const el = e.target.closest?.('[data-btn]')
      if (el) release(el)
    }
  }

  // Release everything if the window loses focus mid-press (alt-tab, etc.)
  // so a button can never get stuck "pressed" with no keyup to clear it.
  function onWindowBlur() {
    for (const el of activeKeys.values()) release(el)
    activeKeys.clear()
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup',   onKeyUp)
  window.addEventListener('blur',    onWindowBlur)

  // ── Destroy ─────────────────────────────────────────────────────────────────
  return {
    destroy() {
      container.removeEventListener('touchstart',  preventDefaults)
      container.removeEventListener('touchmove',   preventDefaults)
      container.removeEventListener('touchend',    preventDefaults)
      container.removeEventListener('touchcancel', preventDefaults)
      container.removeEventListener('touchstart',  onTouchStart)
      container.removeEventListener('touchmove',   onTouchMove)
      container.removeEventListener('touchend',    onTouchEnd)
      container.removeEventListener('touchcancel', onTouchCancel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup',   onKeyUp)
      window.removeEventListener('blur',    onWindowBlur)
      if (moveRafId !== null) cancelAnimationFrame(moveRafId)
      pendingMoves.clear()
      activeTouches.clear()
      activeKeys.clear()
    },
  }
}
