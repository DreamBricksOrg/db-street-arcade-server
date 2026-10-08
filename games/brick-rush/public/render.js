// games/brick-rush/public/render.js
// All drawing for Brick Rush: themed lego tiles (with studs), minifigs,
// the golden 2x4 brick, movers, particles, HUD and the phase screens.

import { T, W, H, TILE } from './maps.js'
import { moverPos } from './physics.js'
import { getParticles, brickHover } from './entities.js'

const CW = W * TILE   // 1280
const CH = H * TILE   // 704

// Frame type + colors (HUD and phase screens) — DreamBricks Design System:
// Poppins for words, IBM Plex Mono for numbers/ids, brand blues instead of
// arcade yellow. The playfield itself (tiles, minifigs, golden brick) keeps
// its own gameplay palette.
const FONT_UI   = '"Poppins", system-ui, sans-serif'
const FONT_DATA = '"IBM Plex Mono", ui-monospace, monospace'
const FRAME = {
  title: '#52cdef',                 // --db-blue-300
  ink:   '#ffffff',
  muted: '#b9c6cc',                 // ~ --db-slate-300
  dim:   '#8597a0',                 // ~ --db-slate-400
  bar:   'rgba(3, 74, 93, 0.78)',   // --db-blue-900 scrim
  scrim: 'rgba(3, 30, 40, 0.8)',
}

/** Lighten (+n) or darken (−n) a #rrggbb color. */
function shade(hex, n) {
  const v = parseInt(hex.slice(1), 16)
  const clamp = (c) => Math.max(0, Math.min(255, c + n))
  const r = clamp((v >> 16) & 255), g = clamp((v >> 8) & 255), b = clamp(v & 255)
  return `rgb(${r},${g},${b})`
}

// ── Top-level draw ───────────────────────────────────────────────────────────

export function draw(ctx, match, now) {
  const theme = match.map?.theme
  ctx.fillStyle = theme?.palette.bg ?? '#0b0d14'
  ctx.fillRect(0, 0, CW, CH)

  switch (match.phase) {
    case 'lobby':      return drawLobby(ctx, match, now)
    case 'countdown':  return drawCountdown(ctx, match, now)
    case 'round':
    case 'grace':      return drawRound(ctx, match, now)
    case 'roundEnd':   return drawRoundEnd(ctx, match, now)
    case 'matchEnd':   return drawMatchEnd(ctx, match, now)
    case 'rotation':   return drawRotation(ctx, match, now)
  }
}

// ── World rendering ──────────────────────────────────────────────────────────

function drawRound(ctx, match, now) {
  const { map } = match
  drawTiles(ctx, map)
  drawMovers(ctx, map, now)
  drawBrick(ctx, map, now)
  drawLava(ctx, match, now)
  for (const p of match.players.values()) drawMinifig(ctx, p, now)
  drawParticles(ctx)
  drawHud(ctx, match, now)
  if (match.phase === 'grace') {
    banner(ctx, `⏳ ${Math.ceil((match.graceDeadline - now) / 1000)}s para os demais!`, 40)
  }
}

function drawTiles(ctx, map) {
  const pal = map.theme.palette
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = map.grid[y * W + x]
      const px = x * TILE, py = y * TILE
      if (t === T.BLOCK) {
        ctx.fillStyle = pal.block
        ctx.fillRect(px, py, TILE, TILE)
        ctx.fillStyle = pal.blockTop
        ctx.fillRect(px, py, TILE, 4)
        // lego studs (only when exposed above)
        if (y === 0 || map.grid[(y - 1) * W + x] !== T.BLOCK) {
          ctx.fillStyle = pal.blockTop
          ctx.beginPath()
          ctx.arc(px + 9, py + 5, 4, 0, Math.PI * 2)
          ctx.arc(px + 23, py + 5, 4, 0, Math.PI * 2)
          ctx.fill()
        }
      } else if (t === T.SLIP) {
        // slippery block (ice/sand): brighter, glossy top stripe
        ctx.fillStyle = pal.slip ?? '#bfeaff'
        ctx.fillRect(px, py, TILE, TILE)
        ctx.fillStyle = pal.slipTop ?? '#ffffff'
        ctx.fillRect(px, py, TILE, 5)
        if (y === 0 || map.grid[(y - 1) * W + x] !== T.SLIP) {
          ctx.beginPath()
          ctx.arc(px + 9, py + 5, 4, 0, Math.PI * 2)
          ctx.arc(px + 23, py + 5, 4, 0, Math.PI * 2)
          ctx.fill()
        }
        // gloss shine
        ctx.fillStyle = 'rgba(255,255,255,0.25)'
        ctx.fillRect(px + 4, py + 12, 10, 3)
      } else if (t === T.ONEWAY) {
        ctx.fillStyle = pal.oneway
        ctx.fillRect(px, py, TILE, 8)
        ctx.beginPath()
        ctx.arc(px + 9, py + 2, 3, 0, Math.PI * 2)
        ctx.arc(px + 23, py + 2, 3, 0, Math.PI * 2)
        ctx.fill()
      } else if (t === T.HAZARD) {
        ctx.fillStyle = pal.hazard
        const wob = Math.sin((x * 13 + Date.now() / 180)) * 2
        ctx.fillRect(px, py + 6 + wob, TILE, TILE - 6 - wob)
      }
    }
  }
}

function drawMovers(ctx, map, now) {
  const pal = map.theme.palette
  for (const m of map.movers) {
    const pos = moverPos(m, now, map.theme.gimmick)
    ctx.fillStyle = pal.accent
    ctx.fillRect(pos.x, pos.y, pos.w, pos.h)
    ctx.fillStyle = pal.blockTop
    ctx.beginPath()
    for (let i = 0; i < 4; i++) ctx.arc(pos.x + 8 + i * 16, pos.y + 2, 3, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawBrick(ctx, map, now) {
  if (!map.brick) return
  const { dy, sparkle } = brickHover(now)
  const bx = map.brick.x, by = map.brick.y + dy
  const bw = 48, bh = 24

  ctx.save()
  ctx.shadowColor = '#ffd700'
  ctx.shadowBlur = 18
  ctx.fillStyle = '#f5b91a'
  ctx.fillRect(bx - bw / 2, by - bh / 2, bw, bh)
  ctx.fillStyle = '#ffe08a'
  ctx.fillRect(bx - bw / 2, by - bh / 2, bw, 5)
  // 2x4 = 8 studs
  ctx.beginPath()
  for (let i = 0; i < 4; i++) {
    ctx.arc(bx - bw / 2 + 7 + i * 12, by - bh / 2 + 4, 3.4, 0, Math.PI * 2)
  }
  ctx.fill()
  // sparkle
  ctx.fillStyle = `rgba(255,255,255,${(Math.sin(sparkle) + 1) / 3})`
  ctx.fillRect(bx - bw / 2 + 6, by - 4, 6, 6)
  ctx.restore()
}

function drawLava(ctx, match, now) {
  if (match.lavaY == null || match.lavaY === Infinity) return
  ctx.fillStyle = 'rgba(255, 90, 31, 0.92)'
  ctx.fillRect(0, match.lavaY, CW, CH - match.lavaY)
  ctx.fillStyle = '#ffb03a'
  for (let x = 0; x < CW; x += 26) {
    const bob = Math.sin(x / 40 + now / 250) * 4
    ctx.fillRect(x, match.lavaY + bob - 3, 14, 5)
  }
}

function drawMinifig(ctx, p, now) {
  if (p.deadUntil > now) return // pieces are flying (particles)

  const x = p.x, y = p.y
  ctx.save()

  // legs
  ctx.fillStyle = shade(p.color, -25)
  ctx.fillRect(x - 9, y + 4, 8, 11)
  ctx.fillRect(x + 1, y + 4, 8, 11)
  // torso (trapezoid-ish)
  ctx.fillStyle = p.color
  ctx.fillRect(x - 10, y - 8, 20, 13)
  // arms
  ctx.fillRect(x - 13, y - 7, 4, 9)
  ctx.fillRect(x + 9, y - 7, 4, 9)
  // head (classic yellow) + stud on top
  ctx.fillStyle = '#f5c518'
  ctx.fillRect(x - 6, y - 19, 12, 11)
  ctx.fillRect(x - 3, y - 22, 6, 3)
  // face looks toward facing
  ctx.fillStyle = '#222'
  const eye = p.facing >= 0 ? 1 : -1
  ctx.fillRect(x - 3 + eye * 2, y - 16, 2, 2)
  ctx.fillRect(x + 1 + eye * 2, y - 16, 2, 2)
  ctx.fillRect(x - 1 + eye * 2, y - 12, 3, 1)

  // finished: little crown
  if (p.finishedAt !== null) {
    ctx.fillStyle = '#ffd700'
    ctx.fillRect(x - 5, y - 26, 10, 3)
  }
  // dash ready glow at feet
  if (now >= p.dashCdUntil) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.fillRect(x - 8, y + 15, 16, 2)
  }
  ctx.restore()
}

function drawParticles(ctx) {
  for (const pt of getParticles()) {
    ctx.save()
    ctx.translate(pt.x, pt.y)
    ctx.rotate(pt.rot)
    ctx.fillStyle = pt.color
    ctx.fillRect(-pt.w / 2, -pt.h / 2, pt.w, pt.h)
    ctx.restore()
  }
}

// ── HUD / screens ────────────────────────────────────────────────────────────

function drawHud(ctx, match, now) {
  const theme = match.map?.theme
  // top bar
  ctx.fillStyle = FRAME.bar
  ctx.fillRect(0, 0, CW, 30)
  ctx.fillStyle = FRAME.ink
  ctx.font = `600 15px ${FONT_UI}`
  ctx.textAlign = 'left'
  ctx.fillText(theme?.name ?? '', 12, 21)
  ctx.font = `600 15px ${FONT_DATA}`
  ctx.textAlign = 'center'
  ctx.fillText(`Round ${match.round}/${match.cfg.rounds}`, CW / 2 - 100, 21)
  const remain = Math.max(0, Math.ceil((match.roundDeadline - now) / 1000))
  ctx.fillStyle = remain <= 10 ? FRAME.title : FRAME.ink
  ctx.fillText(`${remain}s`, CW / 2 + 60, 21)
  ctx.fillStyle = FRAME.ink
  ctx.textAlign = 'right'
  ctx.fillText(`Fila ${match.queueSize}`, CW - 12, 21)

  // score panel (left side)
  const sorted = rankedPlayers(match)
  let y = 48
  ctx.textAlign = 'left'
  ctx.font = `600 13px ${FONT_DATA}`
  for (const p of sorted) {
    ctx.fillStyle = FRAME.bar
    ctx.fillRect(8, y - 14, 180, 20)
    ctx.fillStyle = p.color
    ctx.fillRect(12, y - 10, 12, 12)
    ctx.fillStyle = p.left ? FRAME.dim : FRAME.ink
    const flag = p.finishedAt !== null ? ' · chegou' : (p.left ? ' (saiu)' : '')
    ctx.fillText(`${p.pid.slice(0, 8)}  ${p.points}pt${flag}`, 30, y)
    y += 24
  }
}

export function rankedPlayers(match) {
  return [...match.players.values()].sort((a, b) =>
    b.points - a.points ||
    a.totalCaptureMs - b.totalCaptureMs ||
    a.joinedAt - b.joinedAt)
}

function centerText(ctx, text, y, size = 42, color = FRAME.ink, family = FONT_UI) {
  ctx.fillStyle = color
  ctx.font = `700 ${size}px ${family}`
  ctx.textAlign = 'center'
  ctx.fillText(text, CW / 2, y)
}

function banner(ctx, text, y) {
  ctx.fillStyle = FRAME.bar
  ctx.fillRect(0, y, CW, 44)
  centerText(ctx, text, y + 31, 24)
}

function drawLobby(ctx, match, now) {
  centerText(ctx, 'Brick Rush', CH / 2 - 150, 64, FRAME.title)
  centerText(ctx, 'Escaneie o QR para entrar pelo celular', CH / 2 - 92, 22, FRAME.muted)

  const n = match.players.size
  const max = match.maxPlayers || '?'
  centerText(ctx, `${n}/${max} jogadores`, CH / 2 - 30, 30, FRAME.ink, FONT_DATA)

  // connected minifigs on display
  let x = CW / 2 - (n - 1) * 40
  for (const p of match.players.values()) {
    drawMinifig(ctx, { ...p, x, y: CH / 2 + 40, deadUntil: 0, finishedAt: null, dashCdUntil: Infinity }, now)
    x += 80
  }

  if (n > 0 && match.lobbyDeadline) {
    const remain = Math.max(0, Math.ceil((match.lobbyDeadline - now) / 1000))
    centerText(ctx, `Começa em ${remain}s (ou quando encher)`, CH / 2 + 120, 22, FRAME.title)
  }
  if (match.winStreakPid) {
    centerText(ctx, `${match.winStreakPid.slice(0, 8)} defende o título (${match.winStreakCount}x)`, CH / 2 + 160, 18, FRAME.muted)
  }
  centerText(ctx, `Fila: ${match.queueSize}`, CH - 40, 18, FRAME.dim, FONT_DATA)
}

function drawCountdown(ctx, match, now) {
  const remain = Math.ceil((match.countdownDeadline - now) / 1000)
  centerText(ctx, String(Math.max(1, remain)), CH / 2, 160, FRAME.title, FONT_DATA)
  centerText(ctx, `Round 1 — ${match.nextThemeName ?? ''}`, CH / 2 + 80, 26)
}

function drawRoundEnd(ctx, match, _now) {
  drawTiles(ctx, match.map)
  ctx.fillStyle = FRAME.scrim
  ctx.fillRect(0, 0, CW, CH)
  centerText(ctx, `Fim do round ${match.round}`, 150, 44, FRAME.title)
  let y = 240
  for (const p of rankedPlayers(match)) {
    ctx.fillStyle = p.color
    ctx.fillRect(CW / 2 - 180, y - 20, 24, 24)
    ctx.fillStyle = FRAME.ink
    ctx.font = `600 24px ${FONT_DATA}`
    ctx.textAlign = 'left'
    ctx.fillText(`${p.pid.slice(0, 8)}  +${p.roundPoints} → ${p.points} pts`, CW / 2 - 140, y)
    y += 44
  }
}

function drawMatchEnd(ctx, match, _now) {
  centerText(ctx, 'Fim de jogo', 140, 56, FRAME.title)
  const ranked = rankedPlayers(match)
  const medals = ['1º', '2º', '3º']
  let y = 260
  ranked.forEach((p, i) => {
    ctx.fillStyle = p.color
    ctx.fillRect(CW / 2 - 200, y - 24, 28, 28)
    ctx.fillStyle = FRAME.ink
    ctx.font = `${i === 0 ? 700 : 600} ${i === 0 ? 34 : 26}px ${FONT_DATA}`
    ctx.textAlign = 'left'
    ctx.fillText(`${medals[i] ?? '  '} ${p.pid.slice(0, 8)} — ${p.points} pts`, CW / 2 - 160, y)
    y += 54
  })
}

function drawRotation(ctx, _match, _now) {
  centerText(ctx, 'Girando a fila…', CH / 2 - 20, 40, FRAME.title)
  centerText(ctx, 'Eliminados voltam pela fila. O vencedor fica.', CH / 2 + 30, 20, FRAME.muted)
}
