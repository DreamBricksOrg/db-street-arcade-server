// games/snake/public/game.js
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreList = document.getElementById('scoreList');
const connStatus = document.getElementById('connStatus');
const debugLog = document.getElementById('debugLog');

const GRID_SIZE = 20;
const TILE_COUNT_X = canvas.width / GRID_SIZE;
const TILE_COUNT_Y = canvas.height / GRID_SIZE;

// ── Config do jogo (defaults; sobrescrita pelo .env do server via /config) ──
const CFG = {
  gameSpeed: 5,       // movimentos da cobra por segundo
  pointsPerFood: 10,  // pontos por comida
  boostMoves: 3,      // movimentos por frame segurando B
};

const PALETTE = ['#f38ba8', '#a6e3a1', '#89b4fa', '#f9e2af', '#cba6f7', '#fab387'];
let colorIndex = 0;

let players = {};
// player format: { pid, color, path: [{x,y}], dir: {x,y}, pendingDir: {x,y}, score, alive, gameOver }

let currentTotemId = null; // learned from SSE 'init' handshake
let food = spawnFood();

// ── Lógica Central do Jogo ──────────────────────────────────────────────────
function spawnFood() {
  return {
    x: Math.floor(Math.random() * TILE_COUNT_X),
    y: Math.floor(Math.random() * TILE_COUNT_Y)
  };
}

function processPlayerMove(p, pid, pids) {
  if (!p.alive) return;

  // Atualiza a direção real para a direção pendente lida do gamepad
  p.dir = { ...p.pendingDir };

  const head = p.path[0];
  const newHead = { x: head.x + p.dir.x, y: head.y + p.dir.y };

  p.path.unshift(newHead); // Adiciona a nova cabeça

  // Checa se comeu a comida
  if (newHead.x === food.x && newHead.y === food.y) {
    p.score += CFG.pointsPerFood;
    food = spawnFood();
    updateScoreboard();
  } else {
    p.path.pop(); // Remove rastro se não comeu
  }

  // Checar colisões para a nova cabeça
  // Colisão Parede
  if (newHead.x < 0 || newHead.x >= TILE_COUNT_X || newHead.y < 0 || newHead.y >= TILE_COUNT_Y) {
    die(p); return;
  }

  // Colisão com OUTROS e SI MESMO
  for (let targetPid of pids) {
    let target = players[targetPid];
    if (!target.alive) continue;

    for (let i = 0; i < target.path.length; i++) {
      if (targetPid === pid && i === 0) continue; // ignora a propria cabeca
      
      let segment = target.path[i];
      if (newHead.x === segment.x && newHead.y === segment.y) {
        die(p);
        return; 
      }
    }
  }
}

function updateGame() {
  let pids = Object.keys(players);
  
  for (let pid of pids) {
    let p = players[pid];
    if (!p.alive) continue;

    const moves = p.boosting ? CFG.boostMoves : 1;
    for (let i = 0; i < moves; i++) {
      processPlayerMove(p, pid, pids);
      if (!p.alive) break; // se morrer no meio do boost, interrompe
    }
  }

  draw();
}

function die(player) {
  player.alive = false;
  player.path = [];
  updateScoreboard();

  // Notifica o backend via proxy do server.js — encerra a sessão ativa do totem
  console.log('[die] Calling /end-session for totem:', currentTotemId);
  fetch('/end-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: player.pid }),
  }).catch(() => {});
}

function draw() {
  // Limpa tela
  ctx.fillStyle = '#11111b';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Desenha Comida
  ctx.fillStyle = '#f38ba8'; // redish
  ctx.shadowBlur = 10;
  ctx.shadowColor = '#f38ba8';
  ctx.beginPath();
  let radius = GRID_SIZE / 2;
  ctx.arc(food.x * GRID_SIZE + radius, food.y * GRID_SIZE + radius, radius - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Desenha Cobras
  Object.values(players).forEach(p => {
    if (!p.alive) return;
    
    // Efeito incandescente (Glow) se estiver dando boost
    if (p.boosting) {
      ctx.shadowBlur = 15;
      ctx.shadowColor = p.color;
      ctx.fillStyle = '#ffffff'; // Fica mais brilhante/branco
    } else {
      ctx.shadowBlur = 0;
      ctx.fillStyle = p.color;
    }

    p.path.forEach((part, index) => {
      // Cabeça mais cheia, corpo ligeiramente menor
      const margin = index === 0 ? 0 : 2;
      ctx.fillRect(
        part.x * GRID_SIZE + margin, 
        part.y * GRID_SIZE + margin, 
        GRID_SIZE - margin*2, 
        GRID_SIZE - margin*2
      );
    });

    // Reset shadow pra não afetar outras cobras
    ctx.shadowBlur = 0;
  });
}

function updateScoreboard() {
  scoreList.innerHTML = '';
  Object.values(players)
    .sort((a,b) => b.score - a.score)
    .forEach(p => {
      const li = document.createElement('li');
      li.className = 'score-item';
      li.style.opacity = p.alive ? '1' : '0.4';
      
      li.innerHTML = `
        <div class="score-color" style="background:${p.color}; box-shadow: ${p.boosting ? '0 0 10px ' + p.color : 'none'};"></div>
        <span>${p.pid.slice(0, 6)}</span>
        <span style="margin-left:auto">${p.score}</span>
      `;
      scoreList.appendChild(li);
    });
}

// ── Inicializar Novo Jogador ────────────────────────────────────────────────
function addPlayer(pid) {
  const color = PALETTE[colorIndex % PALETTE.length];
  colorIndex++;
  
  players[pid] = {
    pid, color,
    score: 0,
    alive: true,
    boosting: false,
    // Spawn seguro no centro com variação
    path: [{ 
      x: Math.floor(TILE_COUNT_X/2) + (Math.random()*4-2|0), 
      y: Math.floor(TILE_COUNT_Y/2) + (Math.random()*4-2|0)
    }],
    dir: {x: 1, y: 0},
    pendingDir: {x: 1, y: 0}
  };
  updateScoreboard();
}

// ── SSE: Receber eventos UDP via Node.js Server ──────────────────────────────
const evtSource = new EventSource('/events');

evtSource.onopen = function() {
  connStatus.textContent = "🟢 SSE Conectado ao Demo Server";
  connStatus.style.color = "#a6e3a1"; // Green
};

evtSource.onerror = function() {
  connStatus.textContent = "🔴 SSE Erro/Desconectado";
  connStatus.style.color = "#f38ba8"; // Red
};

evtSource.onmessage = function(event) {
  try {
    const data = JSON.parse(event.data);
    if(data.type === 'connected') {
      console.log('Conectado à ponte UDP/SSE!');
      return;
    }

    // Handshake: o server.js envia o totemId assim que o browser conecta
    if (data.type === 'init') {
      currentTotemId = data.totemId;
      console.log('[SSE] Handshake — totemId:', currentTotemId);
      return;
    }

    // Jogadores entram e saem individualmente — nunca há reset de board.
    if (data.type === 'player_join') {
      console.log('[SSE] player_join:', data.pid);
      if (data.tid) currentTotemId = data.tid;
      return;
    }

    if (data.type === 'player_leave') {
      console.log('[SSE] player_leave:', data.pid);
      delete players[data.pid];
      updateScoreboard();
      return;
    }

    // Add to debug log
    const d = new Date();
    const time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}.${d.getMilliseconds().toString().padStart(3,'0')}`;
    const logLine = document.createElement('div');
    logLine.style.marginBottom = '4px';
    logLine.innerHTML = `<span style="color:#89b4fa">[${time}]</span> pid: <b>${data.pid?.slice(0,6)}</b> act: <b style="color:#f9e2af">${data.a}</b> s: <b>${data.s}</b>`;
    debugLog.prepend(logLine);
    
    // Limit log to max 30 items
    if (debugLog.childNodes.length > 30) {
      debugLog.removeChild(debugLog.lastChild);
    }
    
    // Formato Street Arcade: { sid, pid, a: "dpad_up", s: 1 }
    const { pid, a: action, s: state } = data;
    
    if (!players[pid] && state === 1) {
      addPlayer(pid);
    }
    
    const p = players[pid];
    if (!p) return;

    if (!p.alive) return;

    // Atualiza estado de boost
    if (action === 'btn_B') {
      const isBoostingNow = (state === 1);
      if (p.boosting !== isBoostingNow) {
        p.boosting = isBoostingNow;
        updateScoreboard(); // Para dar o glow no placar tbm
      }
    }

    // Apenas atuar em press (state 1) para direção
    if (state === 1) {
      // Trada as direções evitando curva 180 (voltar pra trás)
      if (action === 'dpad_up'    && p.dir.y !== 1)  p.pendingDir = {x: 0, y: -1};
      if (action === 'dpad_down'  && p.dir.y !== -1) p.pendingDir = {x: 0, y: 1};
      if (action === 'dpad_left'  && p.dir.x !== 1)  p.pendingDir = {x: -1, y: 0};
      if (action === 'dpad_right' && p.dir.x !== -1) p.pendingDir = {x: 1, y: 0};
    }

  } catch(e) {
    console.warn('Erro ao parsear mensagem SSE', e);
  }
};

// ── Boot: carrega config do server e inicia o loop ───────────────────────────
let loopTimer = null;

function startLoop() {
  clearInterval(loopTimer);
  loopTimer = setInterval(updateGame, 1000 / CFG.gameSpeed);
}

fetch('/config')
  .then(r => r.json())
  .then(cfg => { Object.assign(CFG, cfg); startLoop(); })
  .catch(() => { console.warn('[config] usando defaults (/config indisponível)'); startLoop(); });
