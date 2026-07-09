// games/brick-rush/public/match.js
// Match state machine for Brick Rush.
//
//   lobby → countdown → round(1..3) [→ grace] → roundEnd → … → matchEnd → rotation → lobby
//
// Rotation rule: K = min(queueSize, players−1) — the bottom-K placed players
// are eliminated via POST /end-session (their phones show "Jogar novamente"
// and the backend queue advances); the winner NEVER leaves (win-streak).

import { TILE } from './maps.js'
import { generateMap, findSafeSpawn } from './wfc.js'
import { pickThemes } from './maps.js'
import {
  createPlayer, resetForRound, step, lavaHeight, windAt, kill,
} from './physics.js'
import { PALETTE, spawnDeathParticles, updateParticles, clearParticles } from './entities.js'
import { rankedPlayers } from './render.js'

const COUNTDOWN_MS    = 3_000
const ROUND_END_MS    = 5_000
const MATCH_END_MS    = 8_000
const ROTATION_MAX_MS = 5_000
const ROUND_POINTS    = [5, 3, 2] // 1º, 2º, 3º; demais 0

// Defaults — overridable pelo .env do server via GET /config (setConfig).
const DEFAULT_CFG = {
  rounds:      3,
  roundMs:     90_000,
  graceMs:     10_000,
  lobbyWaitMs: 30_000,
}

export function createMatch() {
  return {
    cfg: { ...DEFAULT_CFG },
    phase: 'lobby',
    players: new Map(),      // pid → player
    spectators: new Set(),   // pids waiting for the next lobby
    round: 0,
    map: null,
    themes: [],
    maxPlayers: 0,           // learned from /queue-state
    queueSize: 0,
    lobbyDeadline: null,
    countdownDeadline: 0,
    roundDeadline: 0,
    roundStartedAt: 0,
    graceDeadline: 0,
    phaseDeadline: 0,
    lavaY: Infinity,
    finishOrder: [],
    winStreakPid: null,
    winStreakCount: 0,
    nextThemeName: '',
    rotationStartedAt: 0,
    pendingLeaves: new Set(),

    /** Applies server-provided config (GET /config, from the game's .env). */
    setConfig(cfg = {}) {
      for (const k of Object.keys(DEFAULT_CFG)) {
        const v = Number(cfg[k])
        if (Number.isFinite(v) && v > 0) this.cfg[k] = v
      }
    },

    // ── Events from SSE ──────────────────────────────────────────────────────
    onPlayerJoin(pid, now) {
      if (this.players.has(pid)) return // reconnection of a current player
      // lobby AND countdown accept players — someone connecting during the 3s
      // countdown belongs to this match (the round hasn't started yet).
      const joinable = this.phase === 'lobby' ||
        (this.phase === 'countdown' && (!this.maxPlayers || this.players.size < this.maxPlayers))
      if (joinable) {
        this._addPlayer(pid, now)
        if (this.phase === 'lobby' && !this.lobbyDeadline) this.lobbyDeadline = now + this.cfg.lobbyWaitMs
      } else {
        this.spectators.add(pid)
      }
    },

    onPlayerLeave(pid, now) {
      this.spectators.delete(pid)
      this.pendingLeaves.delete(pid)
      const p = this.players.get(pid)
      if (!p) return
      if (this.phase === 'lobby' || this.phase === 'rotation' || this.phase === 'matchEnd') {
        this.players.delete(pid)
        if (this.players.size === 0 && this.phase === 'lobby') this.lobbyDeadline = null
      } else {
        // mid-match: mark as gone; scores stay for placement, avatar vanishes
        p.left = true
        p.deadUntil = Infinity
      }
    },

    onInput(pid, action, state, now) {
      // Self-heal: input from a pid we never saw means their player_join
      // packet was lost (e.g. the game page opened after the phone connected).
      // Register them like a join would.
      if (!this.players.has(pid) && !this.spectators.has(pid)) {
        this.onPlayerJoin(pid, now)
      }
      const p = this.players.get(pid)
      if (!p || p.left) return
      const pressed = state === 1
      switch (action) {
        case 'dpad_left':  p.input.left = pressed; break
        case 'dpad_right': p.input.right = pressed; break
        case 'dpad_down':  p.input.down = pressed; break
        case 'btn_A':
          if (pressed && !p.input.jump) p.input.jumpEdge = true
          p.input.jump = pressed
          break
        case 'btn_B':
          if (pressed && !p.input.dash) p.input.dashEdge = true
          p.input.dash = pressed
          break
      }
    },

    setQueueState({ queue = [], maxPlayers = 0 }) {
      this.queueSize = queue.length
      if (maxPlayers > 0) this.maxPlayers = maxPlayers
    },

    // ── Tick ─────────────────────────────────────────────────────────────────
    tick(now, dt) {
      updateParticles(dt, now)

      switch (this.phase) {
        case 'lobby': {
          // promote waiting spectators into free lobby slots
          if (this.spectators.size > 0) {
            for (const pid of [...this.spectators]) {
              if (this.maxPlayers && this.players.size >= this.maxPlayers) break
              this.spectators.delete(pid)
              this._addPlayer(pid, now)
              if (!this.lobbyDeadline) this.lobbyDeadline = now + this.cfg.lobbyWaitMs
            }
          }
          const full = this.maxPlayers > 0 && this.players.size >= this.maxPlayers
          const timedOut = this.lobbyDeadline && now >= this.lobbyDeadline && this.players.size >= 1
          if (full || timedOut) {
            this.themes = pickThemes(this.cfg.rounds)
            this.round = 0
            for (const p of this.players.values()) { p.points = 0; p.totalCaptureMs = 0 }
            this.nextThemeName = `${this.themes[0].emoji} ${this.themes[0].name}`
            this.countdownDeadline = now + COUNTDOWN_MS
            this.phase = 'countdown'
          }
          break
        }

        case 'countdown': {
          if (now >= this.countdownDeadline) this._startRound(now)
          break
        }

        case 'round':
        case 'grace': {
          this._stepPlayers(now, dt)

          // brick pickup
          for (const p of this.players.values()) {
            if (p.left || p.finishedAt !== null || p.deadUntil > now) continue
            if (this._touchesBrick(p)) {
              p.finishedAt = now
              p.totalCaptureMs += now - this.roundStartedAt
              const place = this.finishOrder.length
              p.roundPoints = ROUND_POINTS[place] ?? 0
              p.points += p.roundPoints
              this.finishOrder.push(p.pid)
              if (this.phase === 'round') {
                this.phase = 'grace'
                this.graceDeadline = now + this.cfg.graceMs
              }
            }
          }

          const alive = [...this.players.values()].filter(p => !p.left)
          const allDone = alive.length > 0 && alive.every(p => p.finishedAt !== null)
          const graceOver = this.phase === 'grace' && now >= this.graceDeadline
          const timeOver = now >= this.roundDeadline

          if (alive.length === 0) { this._resetToLobby(now); break }
          if (allDone || graceOver || timeOver) {
            // players who didn't capture accrue full round time (tiebreaker)
            for (const p of alive) if (p.finishedAt === null) p.totalCaptureMs += this.cfg.roundMs
            this.phase = 'roundEnd'
            this.phaseDeadline = now + ROUND_END_MS
          }
          break
        }

        case 'roundEnd': {
          if (now >= this.phaseDeadline) {
            if (this.round >= this.cfg.rounds) {
              this.phase = 'matchEnd'
              this.phaseDeadline = now + MATCH_END_MS
            } else {
              this._startRound(now)
            }
          }
          break
        }

        case 'matchEnd': {
          if (now >= this.phaseDeadline) this._startRotation(now)
          break
        }

        case 'rotation': {
          // Wait for the async elimination calls to be issued before judging
          // pendingLeaves — otherwise an empty set ends the rotation early.
          if (this.rotationResolving && now - this.rotationStartedAt < ROTATION_MAX_MS) break
          const done = this.pendingLeaves.size === 0
          const timedOut = now - this.rotationStartedAt >= ROTATION_MAX_MS
          if (done || timedOut) {
            // force-remove any stragglers we already eliminated server-side
            for (const pid of this.pendingLeaves) this.players.delete(pid)
            this.pendingLeaves.clear()
            this._resetToLobby(now, /*keepPlayers*/ true)
          }
          break
        }
      }
    },

    // ── Internals ────────────────────────────────────────────────────────────
    _addPlayer(pid, now) {
      const color = PALETTE[this.players.size % PALETTE.length]
      const p = createPlayer(pid, color, { x: 100, y: 100 })
      p.joinedAt = now
      this.players.set(pid, p)
    },

    _startRound(now) {
      this.round++
      // wraps when cfg.rounds > 6 themes
      const theme = this.themes[(this.round - 1) % this.themes.length]
      this.nextThemeName = `${theme.emoji} ${theme.name}`
      const alive = [...this.players.values()].filter(p => !p.left)
      this.map = generateMap(theme, Math.max(1, alive.length))
      clearParticles()
      this.finishOrder = []
      this.lavaY = Infinity
      alive.forEach((p, i) => resetForRound(p, this.map.spawns[i % this.map.spawns.length], now))
      this.roundStartedAt = now
      this.roundDeadline = now + this.cfg.roundMs
      this.phase = 'round'
    },

    _stepPlayers(now, dt) {
      const gimmick = this.map.theme.gimmick
      this.lavaY = lavaHeight(gimmick, now - this.roundStartedAt)
      const wind = windAt(gimmick, now)

      // Rising lava: keep every respawn point SAFELY above the lava line —
      // otherwise dead players respawn inside it and die in a loop.
      const lavaActive = this.lavaY !== Infinity
      for (const p of this.players.values()) {
        if (p.left || p.finishedAt !== null) continue
        if (lavaActive && p.spawn.y > this.lavaY - 3 * TILE) {
          p.spawn = findSafeSpawn(this.map, this.lavaY, p.x)
        }
        const wasAlive = p.deadUntil <= now
        step(p, this.map, gimmick, dt, now, this.lavaY, wind)
        if (wasAlive && p.deadUntil > now) spawnDeathParticles(p, now)
      }
    },

    _touchesBrick(p) {
      const b = this.map.brick
      return Math.abs(p.x - b.x) < (24 + p.w / 2) && Math.abs(p.y - b.y) < (12 + p.h / 2)
    },

    _startRotation(now) {
      this.phase = 'rotation'
      this.rotationStartedAt = now
      this.rotationResolving = true
      this.pendingLeaves = new Set()
      this._resolveRotation(now).finally(() => { this.rotationResolving = false })
    },

    async _resolveRotation(now) {
      const ranked = rankedPlayers(this).filter(p => !p.left)
      // Champion is remembered for the lobby HUD, but leaves like everyone
      // else — playing again means reconnecting through the queue.
      this.winStreakPid = ranked[0]?.pid ?? null
      this.winStreakCount = this.winStreakPid === this._lastWinnerPid
        ? this.winStreakCount + 1 : 1
      this._lastWinnerPid = this.winStreakPid

      // players who abandoned mid-match are already gone server-side
      for (const p of this.players.values()) if (p.left) this.players.delete(p.pid)

      // End of match: EVERYONE is kicked (including the winner). The backend
      // ends each session, phones show "Jogar novamente", and the queue
      // advances into the freed slots for the next match.
      for (const p of this.players.values()) {
        this.pendingLeaves.add(p.pid)
        fetch('/end-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pid: p.pid }),
        }).catch(() => { /* rotation timeout will clean up */ })
      }
    },

    _resetToLobby(now, keepPlayers = false) {
      if (!keepPlayers) this.players.clear()
      this.phase = 'lobby'
      this.round = 0
      this.map = null
      clearParticles()
      this.lobbyDeadline = this.players.size > 0 ? now + this.cfg.lobbyWaitMs : null
      // survivors reset visual state; scores reset when the next match starts
      for (const p of this.players.values()) {
        p.finishedAt = null
        p.deadUntil = 0
        p.left = false
      }
    },
  }
}
