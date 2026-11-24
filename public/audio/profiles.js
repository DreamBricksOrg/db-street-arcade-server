// public/audio/profiles.js
// Perfil de som de cada jogo (chave = pasta em games/): música em loop e os
// efeitos pelos nomes dos cues que o jogo envia (POST .../cue { cue, pid? }).
// Notas em MIDI (69 = lá 440 Hz); 0 = pausa. Cada passo = 1/16 de compasso.

// Arpejo de um acorde em 8 passos e baixo pulsando em colcheias.
const arp   = (c) => [c[0], c[1], c[2], c[1], c[0], c[1], c[2], c[1]]
const arpUp = (c) => [c[0], c[2], c[1], c[2], c[0], c[2], c[1], c[2]]
const pump  = (r) => [r, 0, r, 0, r, 0, r, 0]
const join  = (...parts) => parts.flat()

// Efeitos que o servidor/celular disparam sozinhos em qualquer jogo.
const COMMON_SFX = {
  join:  [{ f: 520, f2: 880, d: 0.12, t: 'triangle', v: 0.35 }],
  tick:  [{ f: 660, d: 0.1, t: 'square', v: 0.3 }],
  start: [
    { f: 440, d: 0.1, t: 'square', v: 0.3 },
    { f: 660, d: 0.1, t: 'square', v: 0.3, at: 0.1 },
    { f: 880, d: 0.3, t: 'square', v: 0.3, at: 0.2 },
  ],
  over: [
    { f: 400, f2: 50, d: 0.7, t: 'sawtooth', v: 0.4 },
    { f: 900, f2: 60, d: 0.8, t: 'noise', v: 0.5 },
  ],
}

const nave = {
  music: {
    bpm: 128, leadWave: 'square', bassWave: 'triangle', drums: true,
    // Lám – Fá – Dó – Sol
    lead: join(arp([69, 72, 76]), arp([65, 69, 72]), arp([72, 76, 79]), arp([67, 71, 74])),
    bass: join(pump(45), pump(41), pump(48), pump(43)),
  },
  sfx: {
    ...COMMON_SFX,
    fire:  [{ f: 900, f2: 300, d: 0.09, t: 'square', v: 0.22 }],
    break: [
      { f: 1800, f2: 80, d: 0.2, t: 'noise', v: 0.55 },
      { f: 500, f2: 200, d: 0.12, t: 'square', v: 0.2 },
    ],
    enemy: [
      { f: 300, f2: 1000, d: 0.14, t: 'sawtooth', v: 0.3 },
      { f: 2200, f2: 100, d: 0.25, t: 'noise', v: 0.5, at: 0.05 },
    ],
    warn: [{ f: 1200, d: 0.07, t: 'square', v: 0.3 }],
  },
}

const snake = {
  music: {
    bpm: 138, leadWave: 'square', bassWave: 'triangle', drums: false,
    lead: [
      72, 0, 76, 0, 79, 0, 76, 0, 74, 0, 77, 0, 81, 0, 77, 0,
      72, 0, 76, 0, 79, 0, 84, 0, 83, 0, 79, 0, 76, 0, 74, 0,
    ],
    bass: join(pump(48), pump(43), pump(45), pump(43)),
  },
  sfx: {
    ...COMMON_SFX,
    eat:  [{ f: 600, f2: 1200, d: 0.08, t: 'square', v: 0.28 }],
  },
}

const brickRush = {
  music: {
    bpm: 152, leadWave: 'sawtooth', bassWave: 'square', drums: true,
    // Ré m – Si♭ – Fá – Dó
    lead: join(arpUp([74, 77, 81]), arpUp([70, 74, 77]), arpUp([72, 77, 81]), arpUp([72, 76, 79])),
    bass: join(pump(38), pump(34), pump(41), pump(36)),
  },
  sfx: COMMON_SFX,
}

// Jogo sem perfil próprio: música neutra + os efeitos comuns.
const fallback = {
  music: {
    bpm: 120, leadWave: 'triangle', bassWave: 'triangle', drums: false,
    lead: join(arp([69, 72, 76]), arp([67, 71, 74])),
    bass: join(pump(45), pump(43)),
  },
  sfx: COMMON_SFX,
}

export const PROFILES = { nave, snake, 'brick-rush': brickRush }
export const profileFor = (game) => PROFILES[game] ?? fallback
