# Guia de Integração de Jogos — Street Arcade

Como criar um jogo (Unity/C#, browser, Python, C++…) que se conecta ao backend
do Street Arcade e reaproveita a fila, as sessões e o gamepad dos celulares.
Baseado na implementação de referência: **`games/snake/`**.

---

## 1. Arquitetura

O jogo NÃO gerencia fila nem sessões — o backend faz tudo. O jogo só precisa:

```
                    ┌────────────────────────────┐
  celular (gamepad) │        BACKEND :3000       │        SEU JOGO
  ───WebSocket────► │  fila · sessões · rotação  │
                    │                            │
                    │  UDP →  inputs             │ ──► mover o avatar
                    │  UDP →  player_join        │ ──► (opcional) preparar avatar
                    │  UDP →  player_leave       │ ──► REMOVER o avatar
                    │                            │
                    │  ◄── HTTP "jogador morreu" │ ◄── quando o avatar morre
                    └────────────────────────────┘
```

- **Receber UDP** (porta configurada no cadastro do totem): inputs do gamepad
  e eventos de ciclo de vida (`player_join` / `player_leave`).
- **Chamar 1 endpoint HTTP** quando um jogador morre: o backend encerra SÓ a
  sessão daquele jogador e a fila anda automaticamente — o próximo da fila
  entra sem afetar quem continua vivo.

**Modelo de sessão**: 1 sessão = 1 jogador. Um totem com `maxPlayers: 4` terá
até 4 sessões vivas simultâneas e independentes. O jogo nunca "reseta a
partida" quando alguém entra ou sai — jogadores entram e saem individualmente.

---

## 2. Setup

### 2.1 Cadastrar o totem (uma vez, pelo dashboard `/` ou API)

```
POST /api/totems
{ "name": "Meu Jogo", "ip": "<IP da máquina do jogo>", "udpPort": 9001,
  "maxPlayers": 2, "sessionDurationMs": 1800000, "maxQueueSize": 20 }
```

Guarde o `_id` retornado — é o **totemId**. O QR permanente do totem
(`GET /api/totems/:id/qr`) aponta para a tela de fila; é ele que fica colado
na máquina.

### 2.2 Configuração do jogo

O jogo precisa conhecer duas coisas (no games/snake ficam em `games/snake/.env`):

| Config | Exemplo | Para quê |
|---|---|---|
| `BACKEND_URL` | `http://localhost:3000` | Reportar morte de jogador |
| `TOTEM_ID` | `a3743cdc-e8fb-...` | Identificar-se nas chamadas HTTP |

O `TOTEM_ID` também chega dinamicamente no campo `tid` de todo pacote
`player_join` — dá para aprender em runtime (o games/snake faz os dois:
usa o .env e atualiza se o `tid` mudar).

---

## 3. Pacotes UDP que o jogo recebe

Todos são JSON < 512 bytes, um datagrama por evento, na `udpPort` do totem.

### 3.1 Input do gamepad (o mais frequente)

```json
{ "sid": "13dadce6", "pid": "qp_a1b2c", "a": "dpad_up", "s": 1, "ts": 1234567 }
```

| Campo | Significado |
|---|---|
| `sid` | Primeiros 8 chars do sessionId |
| `pid` | Primeiros 8 chars do playerId — **use como chave do jogador** |
| `a` | Ação: `dpad_up` `dpad_down` `dpad_left` `dpad_right` `btn_A` `btn_B` `btn_X` `btn_Y` |
| `s` | `1` = pressionado, `0` = solto |
| `ts` | Últimos 7 dígitos do timestamp (para debug/ordenação) |

### 3.2 `player_join` — jogador conectou o gamepad

```json
{ "type": "player_join", "sid": "13dadce6", "pid": "qp_a1b2c", "tid": "<totemId completo>" }
```

Enviado quando o celular conecta o WebSocket (a sessão vira `active`).
Use para spawnar o avatar — ou, como o games/snake, spawne no primeiro input
mesmo e use o `player_join` só para aprender o `tid`.

### 3.3 `player_leave` — a sessão daquele jogador ACABOU

```json
{ "type": "player_leave", "sid": "13dadce6", "pid": "qp_a1b2c", "tid": "<totemId completo>" }
```

Enviado quando a sessão encerra por **qualquer** motivo: morte reportada pelo
jogo, expulsão pelo operador, tempo esgotado, ou jogador que nunca conectou.
**Obrigatório tratar**: remova o avatar/estado daquele `pid` imediatamente.
Depois disso não chegam mais inputs desse jogador.

> ⚠️ **Convenção do pid truncado**: o jogo só conhece os 8 primeiros chars do
> playerId. Sempre indexe jogadores por esse valor e envie-o de volta ao
> backend nas chamadas HTTP — o backend resolve por prefixo.

---

## 4. Reportar morte — a única chamada HTTP obrigatória

Quando o avatar de um jogador morre no seu jogo:

```
POST {BACKEND_URL}/api/totems/{TOTEM_ID}/end-session
Content-Type: application/json

{ "playerId": "qp_a1b2c" }     ← o pid (truncado) que veio nos pacotes UDP
```

O backend então:
1. Encerra **só** a sessão daquele jogador (`endReason: 'died'`);
2. Desconecta o WebSocket dele (o celular mostra "Sua sessão acabou" +
   botão "Jogar novamente", que o coloca no fim da fila);
3. Envia `player_leave` via UDP para o seu jogo (remova o avatar aqui);
4. Avança a fila: o próximo ganha uma sessão reservada (30s para conectar)
   e recebe `player_join` quando conectar.

Resposta: `200 { "ok": true, "endedSessionId": "..." }` |
`404` se o jogador não tem sessão viva (ex.: já expirou — ignore com segurança).

**Reset total (operador/fim de rodada geral)**: o mesmo endpoint **sem body**
encerra TODAS as sessões do totem de uma vez:

```
POST /api/totems/{TOTEM_ID}/end-session      → { "ok": true, "endedCount": N }
```

Não existe respawn no lugar: morreu → sessão acabou → fila anda. Se o jogador
quiser jogar de novo, volta pela fila (botão no celular). Se o seu jogo tiver
vidas múltiplas, só chame o endpoint quando a ÚLTIMA vida acabar.

---

## 5. Padrões de implementação

### 5.1 Jogo nativo (Unity/C#, Python, C++)

Abra um socket UDP na `udpPort` e processe os datagramas direto:

```
loop:
  packet = udp.receive()
  data = json(packet)
  switch data.type:
    'player_join'  → prepara/spawna jogador data.pid
    'player_leave' → remove jogador data.pid
    default        → input: aplica data.a / data.s no jogador data.pid
                     (spawn lazy se data.pid é novo e data.s == 1)

on player death:
  HTTP POST {BACKEND_URL}/api/totems/{TOTEM_ID}/end-session { playerId: pid }
```

### 5.2 Jogo em browser (padrão games/snake)

Browser não recebe UDP — use um servidor local mínimo como ponte
(copie `games/snake/server.js`, ~100 linhas, zero dependências):

- **UDP :9001 → SSE `/events`**: repassa cada datagrama para o browser via
  Server-Sent Events (`EventSource` no jogo).
- **POST `/end-session` → backend**: proxy da morte — o browser chama o server
  local com `{ pid }`, o server repassa ao backend com o `TOTEM_ID` (assim o
  jogo em JS não precisa conhecer o totemId).
- **GET `/queue-state` → backend**: proxy da fila do totem (HUD, rotação).
- **GET `/config`**: expõe as configurações de gameplay do `.env` pro browser
  (ex.: velocidade no snake; rounds e timers no brick-rush).
- **HTTP :9000**: serve os arquivos estáticos do jogo.

Jogos existentes que seguem este padrão: `games/snake/` (ponte mínima) e
`games/brick-rush/` (com sistema de partidas/rounds) — veja `games/README.md`.

No jogo (`game.js`), o esqueleto de integração é:

```js
const players = {}                       // chave: pid truncado
const evtSource = new EventSource('/events')

evtSource.onmessage = (event) => {
  const data = JSON.parse(event.data)

  if (data.type === 'player_join')  { /* opcional: preparar avatar */ return }
  if (data.type === 'player_leave') { delete players[data.pid]; return }

  // Input: { pid, a, s }
  const { pid, a: action, s: state } = data
  if (!players[pid] && state === 1) spawnPlayer(pid)   // spawn lazy
  applyInput(players[pid], action, state)
}

function onPlayerDeath(player) {
  removeFromBoard(player)
  fetch('/end-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pid: player.pid }),
  }).catch(() => {})
}
```

---

## 6. Checklist para um jogo novo

- [ ] Totem cadastrado com IP/porta UDP da máquina do jogo e `maxPlayers` certo
- [ ] Jogo escuta UDP na porta cadastrada (ou via ponte SSE se for browser)
- [ ] Jogadores indexados pelo `pid` truncado de 8 chars
- [ ] Inputs (`a`/`s`) aplicados; spawn no `player_join` ou no primeiro input
- [ ] `player_leave` remove o avatar (obrigatório)
- [ ] Morte → `POST /api/totems/:id/end-session { playerId: pid }`
- [ ] SEM reset de board quando alguém entra/sai — jogadores são independentes
- [ ] SEM respawn local — quem morreu volta pela fila
- [ ] `BACKEND_URL` + `TOTEM_ID` configuráveis (env)

## 7. Referências

- Implementação exemplo: [`games/snake/server.js`](../games/snake/server.js) (ponte UDP→SSE + proxy) e [`games/snake/public/game.js`](../games/snake/public/game.js) (jogo)
- Quem envia os pacotes: `src/modules/udp/udp.dispatcher.js` (inputs), `src/modules/game/game.handler.js` (`player_join`), `src/modules/totem/totemQueue.service.js` (`player_leave`)
- Teste de ponta a ponta da fila: `npm run test:e2e`
- API completa: `GET /documentation` (Swagger)
