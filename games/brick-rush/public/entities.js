// games/brick-rush/public/entities.js
// Player palette, death particles (lego pieces flying apart) and brick state.

export const PALETTE = [
  '#e3350d', // vermelho
  '#2e6de6', // azul
  '#f5c518', // amarelo
  '#3fa845', // verde
  '#f2681c', // laranja
  '#8e44ad', // roxo
  '#1abcd8', // ciano
  '#e85d9e', // rosa
]

const particles = []

/** Minifig "breaks apart" into lego pieces on death. */
export function spawnDeathParticles(player, now) {
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.5
    const speed = 120 + Math.random() * 180
    particles.push({
      x: player.x, y: player.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 150,
      w: 4 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      color: i % 3 === 0 ? '#f5c518' : player.color, // algumas peças "cabeça"
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 12,
      dieAt: now + 1200,
    })
  }
}

export function updateParticles(dt, now) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]
    if (now >= p.dieAt) { particles.splice(i, 1); continue }
    p.vy += 1400 * dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.rot += p.vrot * dt
  }
}

export function getParticles() {
  return particles
}

export function clearParticles() {
  particles.length = 0
}

/** Brick float animation offset (px) — gentle sine hover + sparkle phase. */
export function brickHover(now) {
  return {
    dy: Math.sin(now / 400) * 5,
    sparkle: (now / 150) % (Math.PI * 2),
  }
}
