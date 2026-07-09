# Brick Rush Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Platformer Lego multiplayer (estilo Transformice) integrado à fila do Street Arcade: minifigs disputam o brick 2x4 em 3 rounds de mapas WFC temáticos, com rotação por colocação.

**Architecture:** Padrão demo-snake — `games/brick-rush/server.js` (ponte UDP→SSE + proxies HTTP, zero deps) e jogo browser em Canvas 2D vanilla, módulos ES. Backend intocado. Máquina de estados de partida no cliente; WFC com validação de alcançabilidade por BFS de saltos.

**Tech Stack:** Node ≥20 (server ponte), ES Modules no browser, Canvas 2D. Sem dependências novas.

**Spec:** `docs/superpowers/specs/2026-07-08-brick-rush-design.md`

---

## Contratos de dados (fonte da verdade — TODOS os módulos seguem isto)

```js
// Tiles (Uint8Array no grid 40×22, index = y*W + x). TILE = 32px → canvas 1280×704.
export const T = { EMPTY: 0, BLOCK: 1, ONEWAY: 2, HAZARD: 3, RAIL: 4 }
export const W = 40, H = 22, TILE = 32

// Mapa entregue por wfc.generateMap(theme, playerCount):
// {
//   theme,                        // objeto de maps.js
//   grid: Uint8Array(W*H),
//   movers: [{ x, y, x2, y2, period }],   // plataformas móveis (px, vai-e-volta)
//   spawns: [{ x, y }],           // px, 1 por jogador, base do mapa
//   brick:  { x, y },             // px, zona superior
//   fallback: boolean             // true se veio do mapa handcrafted
// }

// Jogador (match.js/physics.js):
// { pid, color, x, y, vx, vy, w:22, h:30, onGround, wallDir, facing,
//   dashUntil, dashCdUntil, deadUntil, finishedAt, points, roundPoints,
//   totalCaptureMs, joinedAt, input: { left, right, down, jump, dash, jumpEdge, dashEdge } }

// Fases da partida: 'lobby' | 'countdown' | 'round' | 'grace' | 'roundEnd' | 'matchEnd' | 'rotation'

// Tema (maps.js):
// { id, name, emoji, weights: {tileId: peso}, rules: fn adjacência,
//   gimmick: { friction?, gravityScale?, lavaRiseSpeed?, bouncePads?, conveyor?, wind?, quicksand? },
//   fallbackGrid: string[] }      // 22 strings de 40 chars: ' '=vazio '#'=bloco '-'=oneway '~'=hazard '='=trilho
```

**Física (constantes em physics.js):** `GRAV=2200 px/s²`, `MOVE=260 px/s`, `JUMP_V=680`,
`WALL_SLIDE=90 px/s`, `WALL_JUMP={vx:340, vy:620}`, `DASH_V=640 (150ms, cooldown 3s)`,
coyote 100ms, jump-buffer 100ms. Envelope de salto resultante: ~3.3 tiles de altura,
~5 tiles de alcance horizontal → o BFS valida com envelope conservador **dx≤4, dy≤3**.

**Regras da partida:** rounds=3, pontos por chegada `[5,3,2]` (resto 0), graça 10s,
timer de round 90s, lobby 30s após 1º jogador (ou cheio → countdown 3s),
rotação `K = min(fila, jogadores−1)`, desempate por `totalCaptureMs` e depois `joinedAt`.

---

### Task 1: Scaffold + server ponte

**Files:**
- Create: `games/brick-rush/server.js`, `games/brick-rush/.env`, `games/brick-rush/public/index.html`

- [ ] Copiar `demo-snake/server.js` para `games/brick-rush/server.js` com estas mudanças:
  - `HTTP_PORT = 9100`, `UDP_PORT = 9101`
  - Manter: loader de `.env`, SSE `/events` (com handshake `init`/`connected`), proxy `POST /end-session` (repassa `{ playerId }` pro backend), static server, aprendizado de `tid` via `player_join`.
  - **Adicionar** proxy de fila (o browser não pode chamar o backend direto — sem CORS):

```js
  // Proxy: estado da fila/sessões do totem (para rotação e HUD)
  if (req.method === 'GET' && req.url === '/queue-state') {
    if (!BACKEND_URL || !currentTotemId) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [], queue: [], maxPlayers: 0 }));
      return;
    }
    fetch(`${BACKEND_URL}/api/totems/${currentTotemId}/queue`)
      .then(r => r.json())
      .then(json => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); })
      .catch(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ sessions: [], queue: [], maxPlayers: 0 })); });
    return;
  }
```

- [ ] `.env`: `BACKEND_URL=http://localhost:3000` + `TOTEM_ID=` (deixar vazio — preenchido ao cadastrar o totem do jogo; `tid` também chega via player_join).
- [ ] `public/index.html`: canvas 1280×704 centralizado em fundo escuro, fonte pixel/mono, `<script type="module" src="/main.js">`. HUD é desenhado NO canvas (sem DOM extra).
- [ ] Verificar: `node games/brick-rush/server.js` → loga portas 9100/9101; `curl localhost:9100/queue-state` → JSON vazio.

### Task 2: maps.js — 6 temas + fallbacks

**Files:** Create: `games/brick-rush/public/maps.js`

- [ ] Exportar `T, W, H, TILE` (contrato acima) e `THEMES` — array com 6 temas: gelo (`friction:0.02` vs normal `0.15`), vulcão (`lavaRiseSpeed: 8 px/s`), floresta (`bouncePads:true` — one-way vira trampolim 2×), tecnológico (`conveyor: 120 px/s` em blocos marcados + movers 1.5×), deserto (`quicksand:true` em hazard raso + `wind: rajadas ±90 px/s a cada 6s`), cristal (`gravityScale: 0.6`).
- [ ] Cada tema define `weights` (proporção de EMPTY/BLOCK/ONEWAY/HAZARD/RAIL — ex.: gelo tem mais plataformas largas; vulcão mais hazard) e cores de render (`palette: { block, oneway, bg, hazard }`).
- [ ] Cada tema tem `fallbackGrid`: 22 strings × 40 chars, desenhado à mão, com caminho verificável do chão ao topo (escadas de plataformas + paredes para wall-jump). Todos os 6 passam no BFS da Task 3 (o teste garante).
- [ ] `export function themeById(id)` e `export function pickThemes(n)` (sorteia n distintos).

### Task 3: wfc.js — geração + validação (TDD)

**Files:** Create: `games/brick-rush/public/wfc.js`, `games/brick-rush/test/wfc.test.mjs`

- [ ] **Teste primeiro** (`test/wfc.test.mjs`, roda em Node — wfc.js e maps.js não podem tocar DOM):

```js
import assert from 'node:assert/strict'
import { generateMap, reachable } from '../public/wfc.js'
import { THEMES, T, W, H } from '../public/maps.js'

let fallbacks = 0
for (const theme of THEMES) {
  for (let i = 0; i < 200; i++) {
    const map = generateMap(theme, 3)
    assert.equal(map.grid.length, W * H)
    assert.equal(map.spawns.length, 3)
    if (map.fallback) fallbacks++
    // TODO mapa entregue DEVE ser alcançável por todos os spawns
    for (const s of map.spawns) {
      assert.ok(reachable(map, s), `${theme.id} run ${i}: spawn inalcançável`)
    }
  }
  console.log(`OK ${theme.id}`)
}
console.log(`fallbacks: ${fallbacks}/1200`)
console.log('ALL MAP GENERATION TESTS PASSED')
```

Run: `node games/brick-rush/test/wfc.test.mjs` → FAIL (módulos não existem). 

- [ ] Implementar em `wfc.js`:
  - `generateMap(theme, playerCount)`: até 20 tentativas de `collapse(theme)` + pós-processamento + `reachable()` para cada spawn; falhou tudo → `fromFallback(theme)` (parse do fallbackGrid) com `fallback: true`.
  - `collapse(theme)`: WFC clássico por células — domínio = tiles do tema; bordas forçadas (linha H-1 = BLOCK, colunas 0 e W-1 = BLOCK, 3 linhas do topo com viés EMPTY p/ zona do brick); iteração: célula de menor entropia → sorteio ponderado por `theme.weights` → propagação de restrições de adjacência (`theme.rules(tileA, tileB, dir)` → bool); contradição → aborta tentativa. Regras base compartilhadas: HAZARD nunca adjacente a spawn-row; ONEWAY precisa de EMPTY acima; RAIL precisa de EMPTY nas 4 direções (vira trilho de mover).
  - Pós-processamento: spawns = células EMPTY com BLOCK embaixo nas 3 linhas inferiores, espaçados ≥6 tiles; brick = célula EMPTY nas 3 linhas superiores mais distante (em x) da média dos spawns; RAILs consecutivos viram `movers` (trajeto = extensão do trilho, period = 3s).
  - `reachable(map, spawn)`: BFS de tiles "apoiáveis" (EMPTY com suporte: BLOCK/ONEWAY embaixo, ou parede adjacente = wall-jump spot, ou dentro do trajeto de um mover). Expansão: dx≤4/dy(subida)≤3 sem BLOCK no caminho direto (checagem de linha grossa), queda livre dy ilimitado. Sucesso = alcançar célula adjacente ao brick.
- [ ] Run: `node games/brick-rush/test/wfc.test.mjs` → `ALL MAP GENERATION TESTS PASSED`, taxa de fallback reportada (<10% esperado).

### Task 4: physics.js (+ teste de envelope)

**Files:** Create: `games/brick-rush/public/physics.js`, `games/brick-rush/test/physics.test.mjs`

- [ ] `physics.test.mjs` primeiro: simula `step()` num mapa plano em Node e afirma que o envelope REAL cobre o do BFS — pulo alcança ≥3 tiles de altura e ≥4 tiles de distância; wall-jump sobe ≥2 tiles; dash percorre ≥2.5 tiles. FAIL → implementar → PASS.
- [ ] `physics.js` exporta `createPlayer(pid, color, spawn)`, `step(player, map, gimmick, dt, now)` e `applyGimmicks(...)`:
  - Integração semi-implícita; colisão AABB eixo-a-eixo contra o grid (BLOCK sólido; ONEWAY só de cima e ignorado com input.down; HAZARD → `kill(player, now)` = `deadUntil = now+3000` + reset pro spawn ao renascer).
  - Corrida com aceleração/atrito (atrito do gimmick de gelo), coyote/jump-buffer, wall-slide + wall-jump (`wallDir` quando encostado e caindo), dash com janela/cooldown.
  - Movers: colisão como plataforma cinética — jogador em cima herda o delta.
  - Gimmicks: `gravityScale`, `lavaRiseSpeed` (retorna `lavaY` decrescente — quem fica abaixo morre), `bouncePads` (ONEWAY quica vy=-2×JUMP_V), `conveyor` (vx extra no chão), `wind` (função do tempo), `quicksand` (afunda 20px/s parado em HAZARD raso sem morrer até submergir).

### Task 5: entities.js + render.js

**Files:** Create: `games/brick-rush/public/entities.js`, `games/brick-rush/public/render.js`

- [ ] `entities.js`: `PALETTE` (8 cores lego: vermelho, azul, amarelo, verde, laranja, roxo, ciano, rosa), `spawnDeathParticles(player)` (6-8 retângulos "peças" com velocidade radial + gravidade, TTL 1.2s), estado do brick (flutuação senoidal + brilho).
- [ ] `render.js`: `draw(ctx, state)` — céu/bg do tema; tiles como bricks lego (retângulo + 2 studs circulares no topo, cor da palette do tema; ONEWAY como placa fina; HAZARD animado; lava do vulcão como retângulo subindo); movers; brick 2x4 dourado com 8 studs; minifigs (corpo trapezoidal, cabeça amarela, cor do jogador, olhos na direção do facing, "quebrado" durante deadUntil); partículas; HUD superior (round X/3, timer, fila: N) e placar lateral (cor, pid curto, pontos, ✓ quando pegou o brick); telas de lobby (jogadores conectados X/N + countdown 30s), roundEnd (pontos do round), matchEnd (pódio) e rotation ("girando a fila…").

### Task 6: match.js — máquina de estados + rotação

**Files:** Create: `games/brick-rush/public/match.js`

- [ ] `createMatch()` retorna objeto com `phase`, `players: Map<pid, player>`, `spectators: Set<pid>`, `round`, `map`, `themesLeft`, e métodos:
  - `onPlayerJoin(pid)`: em `lobby` → adiciona jogador (cor da PALETTE na ordem); senão → spectator (entra no próximo lobby). Primeiro jogador do lobby arma `lobbyDeadline = now+30000`.
  - `onPlayerLeave(pid)`: remove de players/spectators; se partida em curso, mantém pontos históricos p/ colocação (jogador `left: true`, pontua 0 dali em diante); 0 jogadores vivos → reset pro lobby.
  - `onInput(pid, action, state)`: mapeia `dpad_left/right/down` → held; `btn_A` → jump (+edge); `btn_B` → dash (+edge). Ignora quem não é player.
  - `tick(now, dt)`: avança a fase:
    - `lobby`: cheio (`players.size === maxPlayers` via queue-state) OU deadline → `countdown` (3s). Promove spectators a players se há vaga.
    - `countdown` → `round`: `map = generateMap(nextTheme, players.size)`, posiciona todos nos spawns, zera roundPoints.
    - `round`: physics.step em todos; contato AABB com o brick → `finishedAt = now`, pontos por ordem `[5,3,2]`; 1º contato inicia `grace` (10s); timer 90s → `roundEnd`.
    - `grace`: demais podem pegar; 10s ou todos pegaram → `roundEnd`.
    - `roundEnd` (5s de placar) → `round` seguinte ou `matchEnd` (após o 3º).
    - `matchEnd` (8s de pódio): calcula colocação (pontos ↓, totalCaptureMs ↑, joinedAt ↑) → `rotation`.
    - `rotation`: `GET /queue-state` → `K = min(queue.length, players.size − 1)` → para cada um dos K últimos colocados: `POST /end-session { pid }`; aguarda os `player_leave` chegarem (ou 5s) → `lobby` (vencedor permanece com win-streak++ no HUD).
- [ ] Sem round ativo, inputs são ignorados (exceto exibição no lobby: minifig "de pé" na vitrine).

### Task 7: main.js — wiring

**Files:** Create: `games/brick-rush/public/main.js`

- [ ] `EventSource('/events')`: `init` → guarda totemId (só log; proxies usam o do server); `player_join` → `match.onPlayerJoin(pid)`; `player_leave` → `match.onPlayerLeave(pid)`; default (input) → `match.onInput(pid, a, s)`.
- [ ] Loop `requestAnimationFrame`: `match.tick(now, dt)` (dt clampado a 33ms) → `render.draw(ctx, match)`.
- [ ] Polling leve de `/queue-state` a cada 5s → HUD (tamanho da fila) e `maxPlayers` do totem.

### Task 8: Verificação final + README

**Files:** Create: `games/brick-rush/README.md`

- [ ] `node games/brick-rush/test/wfc.test.mjs` → PASS; `node games/brick-rush/test/physics.test.mjs` → PASS; `node --check` em todos os .js.
- [ ] README: como cadastrar o totem (udpPort 9101, maxPlayers 2–4), configurar .env, rodar (`node server.js`), abrir `http://localhost:9100` na TV; referência ao `docs/game-integration.md`.
- [ ] Teste manual guiado: backend + brick-rush + 3 celulares + 2 na fila → partida completa → rotação correta (2 últimos saem com tela "Jogar novamente", vencedor fica, 2 da fila entram).

## Self-Review

- **Spec coverage**: rounds/pontos/graça (T6), morte-respawn 3s (T4), lobby 30s (T6), rotação K com vencedor imune (T6), WFC+BFS+fallback (T2/T3), 6 gimmicks (T2/T4), controles (T6 onInput), proxies CORS (T1), teste 200×6 (T3). ✔
- **Consistência de tipos**: contratos centralizados no topo; T do maps.js importado por wfc/physics/render. ✔
- **pid truncado**: todo pid vem dos pacotes (já truncado); end-session envia o mesmo valor. ✔
