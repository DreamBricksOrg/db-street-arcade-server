// games/nave/public/game.js
// A nave da TV do site da Dream Bricks, jogável: estrelas passando, nave laranja
// com brilho, blocos (asteroides) e naves inimigas vindo da direita, explosões
// de partículas e HI-SCORE. Sem jogadores roda o piloto automático do site.
// Contrato do jogo: SSE 'events' (player_join / player_leave / inputs),
// 'config', 'end-session' — URLs relativas, iguais na ponte e no /embed.
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;
const ORANGE = '#ff5722';

const CFG = {
  speed: 4,      // 1–10: velocidade dos blocos/inimigos e frequência de spawn
  blockPoints: 25,
  enemyPoints: 50,
  breakTimeout: 10, // s sem quebrar um bloco = a nave explode
};

const SHIP_SPEED = 200;      // px/s
const BOOST_MULT = 2;        // B: vertical mais rápido
const SHIP_MIN_X = 20, SHIP_MAX_X = 230; // a nave fica no lado esquerdo, como no site
const FIRE_COOLDOWN = 0.25;
const PALETTE = [ORANGE, '#4ee1ff', '#7dff7a', '#ffd23f', '#ff7ad9', '#b79cff', '#ffffff', '#5cffc4'];

// ── Estado ──────────────────────────────────────────────────────────────────
let players = {};   // pid → { pid, color, x, y, score, alive, up, down, left, right, fire, cooldown, deadFor }
let names = {};     // pid → apelido (player_join.nm)
let colorIndex = 0;
let obstacles = []; // { x, y, w, h, speed, type: 'asteroid' | 'enemy' }
let lasers = [];    // { x, y, pid }
let particles = [];
let hiScore = 0;
let spawnTimer = 0;
let elapsed = 0;    // segundos com gente jogando (rampa de dificuldade)
let t = 0;
const stars = Array.from({ length: 40 }, () => ({
  x: Math.random() * W, y: Math.random() * H, size: Math.random() * 2, speed: (Math.random() * 2 + 1) * 60,
}));

// Piloto automático (idêntico ao da TV do site) quando ninguém está jogando.
const demo = { x: 80, y: 200, targetY: 200, score: 8000 };

const alivePlayers = () => Object.values(players).filter(p => p.alive);

function addPlayer(pid) {
  if (players[pid]) return players[pid];
  if (!alivePlayers().length) { obstacles = []; lasers = []; elapsed = 0; spawnTimer = 0; }
  const n = Object.keys(players).length;
  players[pid] = {
    pid, x: 50 + (n % 4) * 30, y: 60 + ((n * 97) % (H - 120)), score: 0, alive: true,
    up: false, down: false, left: false, right: false, fire: false, boost: false, cooldown: 0, deadFor: 0,
    timer: CFG.breakTimeout,
    color: PALETTE[colorIndex++ % PALETTE.length],
  };
  return players[pid];
}

function explode(x, y, color) {
  for (let i = 0; i < 12; i++) {
    particles.push({
      x, y, vx: (Math.random() - 0.5) * 360, vy: (Math.random() - 0.5) * 360, life: 1,
      color: Math.random() > 0.5 ? color : '#ffffff',
    });
  }
}

function spawnObstacle() {
  const asteroid = Math.random() < 0.5;
  const baseY = Math.random() * (H - 80) + 40;
  obstacles.push({
    x: W + 30, y: baseY, baseY, age: 0, phase: Math.random() * 6.28,
    amp: Math.min(70, elapsed * 1.2), // onda cresce com o tempo: passa por cima/baixo da nave
    w: asteroid ? 18 : 22, h: asteroid ? 18 : 16,
    speed: (Math.random() * 1.5 + 3) * 60 * (CFG.speed / 4) * (1 + Math.min(1, elapsed / 120)),
    type: asteroid ? 'asteroid' : 'enemy',
  });
}

function kill(p) {
  p.alive = false;
  p.deadFor = 1.2;
  explode(p.x, p.y, p.color);
  explode(p.x, p.y, '#ffffff');
  fetch('end-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: p.pid, score: Math.floor(p.score) }),
  }).catch(() => {});
}

// ── Atualização ─────────────────────────────────────────────────────────────
function update(dt) {
  t += dt;
  const f = dt * 60; // equivalente em "frames" de 60 Hz (a lógica do site é por frame)
  for (const s of stars) { s.x -= s.speed * dt; if (s.x < 0) s.x = W; }
  for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= 0.03 * f; }
  particles = particles.filter(p => p.life > 0);

  const live = alivePlayers();
  const playing = live.length > 0;
  if (playing) elapsed += dt;

  // Spawn: 1 a cada ~1,17 s no piloto automático (70 frames); com gente jogando
  // acelera com a dificuldade e com o número de naves.
  const interval = playing
    ? Math.max(0.2, (70 / 60) / (CFG.speed / 4) / Math.sqrt(live.length) / (1 + elapsed / 30))
    : 70 / 60;
  spawnTimer += dt;
  if (spawnTimer >= interval) { spawnTimer = 0; spawnObstacle(); }

  if (playing) {
    for (const p of live) {
      p.x = Math.max(SHIP_MIN_X, Math.min(SHIP_MAX_X, p.x + (p.right - p.left) * SHIP_SPEED * dt));
      p.y = Math.max(20, Math.min(H - 30, p.y + (p.down - p.up) * SHIP_SPEED * (p.boost ? BOOST_MULT : 1) * dt));
      p.timer -= dt;
      if (p.timer <= 0) { kill(p); continue; }
      p.cooldown -= dt;
      if (p.fire && p.cooldown <= 0) { lasers.push({ x: p.x + 14, y: p.y, pid: p.pid }); p.cooldown = FIRE_COOLDOWN; }
    }
  } else if (obstacles.length) {
    // Piloto automático do site: persegue o obstáculo mais próximo e o explode.
    const closest = obstacles.reduce((a, b) => (b.x > demo.x && b.x < a.x ? b : a), { x: 9999, y: 200 });
    demo.targetY = closest.x !== 9999 ? closest.y - 15 : H / 2 + Math.sin(t * 3) * 60;
  } else {
    demo.targetY = H / 2 + Math.sin(t * 3) * 60;
  }
  demo.y += (demo.targetY - demo.y) * (1 - Math.pow(0.9, f));
  demo.score += 2 * f;

  for (const l of lasers) l.x += 420 * dt;
  lasers = lasers.filter(l => l.x < W + 10);

  for (const o of obstacles) {
    o.x -= o.speed * dt;
    o.age += dt;
    o.y = Math.max(20, Math.min(H - 30, o.baseY + Math.sin(o.age * 3 + o.phase) * o.amp));
    for (const l of lasers) {
      if (l.x >= o.x - o.w / 2 && l.x <= o.x + o.w / 2 + 4 && Math.abs(l.y - o.y) < o.h / 2 + 2) {
        l.x = W + 99;
        o.dead = true;
        explode(o.x, o.y, ORANGE);
        const shooter = players[l.pid];
        if (shooter && shooter.alive) {
          shooter.score += o.type === 'enemy' ? CFG.enemyPoints : CFG.blockPoints;
          shooter.timer = CFG.breakTimeout;
        }
      }
    }
    if (!o.dead) {
      for (const p of live) {
        if (p.alive && Math.abs(o.x - p.x) < o.w / 2 + 10 && Math.abs(o.y - p.y) < o.h / 2 + 7) { o.dead = true; kill(p); }
      }
      // Piloto automático: bater no obstáculo o quebra (sem perder).
      if (!playing && o.x < demo.x + 20 && o.x > demo.x - 10 && Math.abs(o.y - demo.y) < 20) { o.dead = true; explode(o.x, o.y, ORANGE); }
    }
    if (o.x < -40) o.dead = true;
  }
  obstacles = obstacles.filter(o => !o.dead);

  for (const p of Object.values(players)) {
    if (!p.alive) p.deadFor -= dt;
    if (p.score > hiScore) hiScore = p.score;
  }
  for (const pid of Object.keys(players)) if (!players[pid].alive && players[pid].deadFor <= 0) delete players[pid];
}

// ── Desenho ─────────────────────────────────────────────────────────────────
function glow(color, blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }

function drawShip(x, y, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  glow(color, 12);
  ctx.beginPath();
  ctx.moveTo(14, 0); ctx.lineTo(-10, -8); ctx.lineTo(-6, 0); ctx.lineTo(-10, 8);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-12, -3, 4, 6);
  ctx.restore();
}

function draw() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
  for (const s of stars) ctx.fillRect(s.x, s.y, s.size, s.size);

  ctx.strokeStyle = 'rgba(255, 87, 34, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H - 20); ctx.lineTo(W, H - 20); ctx.stroke();

  const live = alivePlayers();
  if (!live.length) drawShip(demo.x, demo.y, ORANGE);
  for (const p of live) {
    drawShip(p.x, p.y, p.color);
    // contagem até explodir: fica vermelha nos últimos 3 s
    ctx.fillStyle = p.timer <= 3 ? '#ff3b3b' : p.color;
    ctx.font = '500 10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(Math.ceil(p.timer), p.x, p.y + 12);
  }

  for (const l of lasers) {
    ctx.save(); ctx.fillStyle = '#fff'; glow('#fff', 6); ctx.fillRect(l.x, l.y - 1, 10, 2); ctx.restore();
  }

  for (const o of obstacles) {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.fillStyle = ORANGE;
    glow(ORANGE, 6);
    if (o.type === 'asteroid') ctx.fillRect(-o.w / 2, -o.h / 2, o.w, o.h);
    else {
      ctx.beginPath();
      ctx.moveTo(-10, -10); ctx.lineTo(12, 0); ctx.lineTo(-10, 10); ctx.lineTo(-4, 0);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  for (const p of particles) {
    ctx.save(); ctx.globalAlpha = p.life; ctx.fillStyle = p.color; glow(p.color, 8); ctx.fillRect(p.x, p.y, 3, 3); ctx.restore();
  }

  // HI-SCORE no topo, como no site
  const shown = live.length || hiScore ? Math.floor(hiScore) : Math.floor(demo.score);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255, 87, 34, 0.85)';
  ctx.font = '500 10px "IBM Plex Mono", monospace';
  ctx.fillText('H I - S C O R E', W / 2, 8);
  ctx.fillStyle = '#fff';
  ctx.font = '600 20px "IBM Plex Mono", monospace';
  ctx.fillText(String(shown).padStart(5, '0'), W / 2, 22);

  // Placar dos jogadores (melhores 4)
  ctx.font = '500 11px "IBM Plex Mono", monospace';
  Object.values(players).sort((a, b) => b.score - a.score).slice(0, 4).forEach((p, n) => {
    ctx.globalAlpha = p.alive ? 1 : 0.4;
    ctx.fillStyle = p.color;
    ctx.textAlign = 'left';
    ctx.fillText((names[p.pid] ?? p.pid.slice(0, 6)).slice(0, 16), 10, 10 + n * 14);
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.floor(p.score)), W - 10, 10 + n * 14);
  });
  ctx.globalAlpha = 1;

  if (!live.length && Math.floor(t * 1.5) % 2 === 0) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = '600 12px "IBM Plex Mono", monospace';
    ctx.fillText('ESCANEIE O QR CODE PARA JOGAR', W / 2, H - 40);
  }
}

// ── Entrada (SSE do backend) ────────────────────────────────────────────────
function onInput(pid, action, state) {
  const p = players[pid] ?? (state === 1 ? addPlayer(pid) : null);
  if (!p || !p.alive) return;
  const on = state === 1;
  if (action === 'dpad_up') p.up = on;
  else if (action === 'dpad_down') p.down = on;
  else if (action === 'dpad_left') p.left = on;
  else if (action === 'dpad_right') p.right = on;
  else if (action === 'btn_A') p.fire = on;
  else if (action === 'btn_B') p.boost = on;
}

const evtSource = new EventSource('events');
evtSource.onmessage = (event) => {
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (data.type === 'player_join') {
    if (data.nm) names[data.pid] = data.nm;
    addPlayer(data.pid);
  } else if (data.type === 'player_leave') {
    delete players[data.pid];
  } else if (data.pid && data.a) {
    onInput(data.pid, data.a, data.s);
  }
};

// Teclado só para testar sem celular: abra com ?kbd=1 (setas + espaço).
if (new URLSearchParams(location.search).has('kbd')) {
  const map = { ArrowUp: 'dpad_up', ArrowDown: 'dpad_down', ArrowLeft: 'dpad_left', ArrowRight: 'dpad_right', ' ': 'btn_A', Shift: 'btn_B' };
  const key = (state) => (e) => { if (map[e.key]) { e.preventDefault(); onInput('teclado', map[e.key], state); } };
  addPlayer('teclado');
  addEventListener('keydown', key(1));
  addEventListener('keyup', key(0));
}

fetch('config').then(r => r.json()).then(cfg => Object.assign(CFG, cfg)).catch(() => {});

// ── Loop ────────────────────────────────────────────────────────────────────
let last = performance.now();
function loop(now) {
  update(Math.min(0.05, (now - last) / 1000));
  last = now;
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
