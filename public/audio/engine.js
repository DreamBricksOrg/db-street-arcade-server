// public/audio/engine.js
// Som do jogo no CELULAR do jogador (gamepad): música em loop + efeitos
// disparados por "cues" que o jogo manda pelo servidor. Tudo sintetizado com
// WebAudio (sem arquivos); cada jogo tem um perfil em profiles.js.
//
//   const audio = createAudio(profile)
//   audio.unlock()     // dentro de um gesto do usuário (o iOS/Chrome exigem)
//   audio.cue('fire')  // efeito
//   audio.stop()       // fim da sessão

const MUTE_KEY = 'sa_muted'
const readMuted  = () => { try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false } }
const writeMuted = (m) => { try { localStorage.setItem(MUTE_KEY, m ? '1' : '0') } catch { /* sem storage: vale só nesta página */ } }

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12)

export function createAudio(profile) {
  let ctx = null
  let master = null
  let musicBus = null
  let noise = null
  let timer = null
  let step = 0
  let nextTime = 0
  let wantMusic = false
  let muted = readMuted()
  const lastCue = {}

  function ensure() {
    if (ctx) return ctx
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = muted ? 0 : 0.8
    master.connect(ctx.destination)
    musicBus = ctx.createGain()
    musicBus.gain.value = 0.2
    musicBus.connect(master)
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const data = noise.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    return ctx
  }

  // Um som: oscilador (ou ruído filtrado) com envelope de volume e glissando f → f2.
  function tone(dest, { f, f2 = f, d, t = 'square', v = 0.3, ft = 'lowpass' }, when) {
    const g = ctx.createGain()
    g.gain.setValueAtTime(v, when)
    g.gain.exponentialRampToValueAtTime(0.001, when + d)
    g.connect(dest)
    let src
    if (t === 'noise') {
      src = ctx.createBufferSource()
      src.buffer = noise
      const filter = ctx.createBiquadFilter()
      filter.type = ft
      filter.frequency.setValueAtTime(f, when)
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, f2), when + d)
      src.connect(filter)
      filter.connect(g)
    } else {
      src = ctx.createOscillator()
      src.type = t
      src.frequency.setValueAtTime(f, when)
      if (f2 !== f) src.frequency.exponentialRampToValueAtTime(f2, when + d)
      src.connect(g)
    }
    src.start(when)
    src.stop(when + d + 0.02)
  }

  // Sequenciador com antecipação: agenda as notas dos próximos ~300 ms a cada 100 ms.
  function schedule() {
    const m = profile.music
    const stepDur = 60 / m.bpm / 4 // semicolcheia
    while (nextTime < ctx.currentTime + 0.3) {
      const i = step % m.lead.length
      const lead = m.lead[i]
      const bass = m.bass[i % m.bass.length]
      if (lead) tone(musicBus, { f: hz(lead), d: stepDur * 0.9, t: m.leadWave ?? 'square', v: 0.45 }, nextTime)
      if (bass) tone(musicBus, { f: hz(bass), d: stepDur * 1.8, t: m.bassWave ?? 'triangle', v: 0.7 }, nextTime)
      if (m.drums) {
        if (i % 8 === 0) tone(musicBus, { f: 130, f2: 40, d: 0.14, t: 'sine', v: 0.9 }, nextTime)
        if (i % 2 === 1) tone(musicBus, { f: 7000, f2: 7000, d: 0.04, t: 'noise', ft: 'highpass', v: 0.12 }, nextTime)
      }
      nextTime += stepDur
      step++
    }
  }

  function startTimer() {
    if (timer || !ctx || ctx.state !== 'running' || !wantMusic) return
    nextTime = ctx.currentTime + 0.05
    timer = setInterval(schedule, 100)
  }
  function stopTimer() { clearInterval(timer); timer = null }

  const onVisibility = () => {
    if (!ctx) return
    if (document.hidden) { stopTimer(); ctx.suspend().catch(() => {}) }
    else ctx.resume().then(startTimer).catch(() => {})
  }
  document.addEventListener('visibilitychange', onVisibility)

  return {
    get muted() { return muted },
    get running() { return !!ctx && ctx.state === 'running' },

    /** Chamar dentro de um toque/clique; é seguro repetir. */
    unlock() {
      if (!ensure()) return
      ctx.resume().then(startTimer).catch(() => {})
    },

    /** Liga a música (começa de fato quando o áudio estiver liberado). */
    startMusic() { wantMusic = true; startTimer() },
    stopMusic() { wantMusic = false; stopTimer() },

    cue(name) {
      const segs = profile.sfx?.[name]
      if (!segs || !ctx || ctx.state !== 'running' || muted) return
      const now = ctx.currentTime
      if (now - (lastCue[name] ?? -1) < 0.04) return // não empilha o mesmo efeito
      lastCue[name] = now
      for (const s of segs) tone(master, s, now + (s.at ?? 0))
    },

    setMuted(m) {
      muted = m
      writeMuted(m)
      if (master) master.gain.setTargetAtTime(m ? 0 : 0.8, ctx.currentTime, 0.02)
    },

    /** Para a música e fecha o áudio (deixa o efeito final terminar). */
    stop(afterMs = 1500) {
      wantMusic = false
      stopTimer()
      document.removeEventListener('visibilitychange', onVisibility)
      if (ctx) setTimeout(() => ctx.close().catch(() => {}), afterMs)
    },
  }
}
