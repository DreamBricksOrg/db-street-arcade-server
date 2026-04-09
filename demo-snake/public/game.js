// demo-snake/public/game.js
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreList = document.getElementById('scoreList');
const connStatus = document.getElementById('connStatus');
const debugLog = document.getElementById('debugLog');

const GRID_SIZE = 20;
const TILE_COUNT_X = canvas.width / GRID_SIZE;
const TILE_COUNT_Y = canvas.height / GRID_SIZE;
const GAME_SPEED = 10; // Velocidade da cobra (quadros por segundo)

const PALETTE = ['#f38ba8', '#a6e3a1', '#89b4fa', '#f9e2af', '#cba6f7', '#fab387'];
let colorIndex = 0;

let players = {}; 
// player format: { pid, color, path: [{x,y}], dir: {x,y}, pendingDir: {x,y}, score, alive }

let food = spawnFood();

// ── Lógica Central do Jogo ──────────────────────────────────────────────────
function spawnFood() {
  return {
    x: Math.floor(Math.random() * TILE_COUNT_X),
    y: Math.floor(Math.random() * TILE_COUNT_Y)
  };
}

function updateGame() {
  let pids = Object.keys(players);
  
  // Computa a nova posição de todas as cobras vivas
  for (let pid of pids) {
    let p = players[pid];
    if (!p.alive) continue;

    // Atualiza a direção real para a direção pendente lida do gamepad
    p.dir = { ...p.pendingDir };

    const head = p.path[0];
    const newHead = { x: head.x + p.dir.x, y: head.y + p.dir.y };

    p.path.unshift(newHead); // Adiciona a nova cabeça

    // Checa se comeu a comida
    if (newHead.x === food.x && newHead.y === food.y) {
      p.score += 10;
      food = spawnFood();
      updateScoreboard();
    } else {
      p.path.pop(); // Remove rastro se não comeu
    }
  }

  // Checar colisões após mover todos (para empates / batidas)
  for (let pid of pids) {
    let p = players[pid];
    if (!p.alive) continue;

    const head = p.path[0];

    // Colisão Parede
    if (head.x < 0 || head.x >= TILE_COUNT_X || head.y < 0 || head.y >= TILE_COUNT_Y) {
      die(p); continue;
    }

    // Colisão com OUTROS e SI MESMO
    for (let targetPid of pids) {
      let target = players[targetPid];
      if (!target.alive) continue;

      // Iterar pelos segmentos do alvo (se for si próprio, ignora o indice 0 pois é a cabeça atual)
      for (let i = 0; i < target.path.length; i++) {
        if (targetPid === pid && i === 0) continue; 
        
        let segment = target.path[i];
        if (head.x === segment.x && head.y === segment.y) {
          die(p);
          break; // quebra loop segment
        }
      }
    }
  }

  draw();
}

function die(player) {
  player.alive = false;
  player.path = [];
  updateScoreboard();
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
    
    ctx.fillStyle = p.color;
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
        <div class="score-color" style="background:${p.color}"></div>
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
    
    // Só ligamos para o PRESS (s === 1) ou botões A/B para respawn
    if (state !== 1) return;

    if (!players[pid]) {
      addPlayer(pid);
    }
    
    const p = players[pid];

    if (!p.alive && action === 'btn_A') {
      // Respawn pressionando A
      addPlayer(pid); 
    }

    if (!p.alive) return;

    // Trada as direções evitando curva 180 (voltar pra trás)
    if (action === 'dpad_up'    && p.dir.y !== 1)  p.pendingDir = {x: 0, y: -1};
    if (action === 'dpad_down'  && p.dir.y !== -1) p.pendingDir = {x: 0, y: 1};
    if (action === 'dpad_left'  && p.dir.x !== 1)  p.pendingDir = {x: -1, y: 0};
    if (action === 'dpad_right' && p.dir.x !== -1) p.pendingDir = {x: 1, y: 0};

  } catch(e) {
    console.warn('Erro ao parsear mensagem SSE', e);
  }
};

// Start Game Loop
setInterval(updateGame, 1000 / GAME_SPEED);
