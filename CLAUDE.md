# Street Arcade Backend — Contexto do Projeto

## Visão Geral

Backend Node.js + Fastify para um sistema de arcade real-time chamado **Street Arcade** (DreamBricks). Gerencia sessões de jogo via QR codes, conexões WebSocket para controles de jogo nos celulares dos jogadores, e comunicação UDP com totens de arcade físicos (máquinas Unity/C#).

**Fluxo central**: Jogador escaneia QR → entra na fila → recebe sessão → abre gamepad no celular → inputs WebSocket → Redis Pub/Sub → UDP → Totem.

---

## Stack & Dependências Principais

- **Runtime**: Node.js ≥ 20, ES Modules (`"type": "module"`)
- **Framework**: Fastify 5.x
- **Banco**: MongoDB (`@fastify/mongodb`)
- **Cache/Pub-Sub**: Redis via ioredis (2 clientes separados: publisher + subscriber)
- **WebSocket**: `@fastify/websocket`
- **UDP**: Node.js `dgram` (send-only, sem bind)
- **QR Code**: `qrcode`
- **Logs**: Pino + pino-pretty
- **Docs**: `@fastify/swagger` + `@fastify/swagger-ui`
- **Dev**: `node --watch` (sem nodemon)

---

## Estrutura de Diretórios

```
src/
├── server.js                  # Entry point; graceful shutdown (SIGTERM/SIGINT)
├── app.js                     # buildApp() — factory do Fastify; ordem de boot dos plugins
├── config/env.js              # Validação de variáveis de ambiente (falha rápida)
├── lib/
│   ├── logger.js              # Pino logger factory
│   ├── channels.js            # Nomes de canais Redis + builders de mensagem
│   ├── mutex.js               # Mutex por chave (serializa fila por totem)
│   └── rateLimit.js           # Rate limiter fixed-window em memória
├── plugins/
│   ├── redis.js               # fastify.redisPublisher + fastify.redisSubscriber
│   ├── mongodb.js             # Conexão + criação de índices
│   ├── websocket.js           # Registro do @fastify/websocket (max payload 512b)
│   ├── udp.js                 # fastify.udpSend(ip, port, msg) — socket dgram
│   ├── static.js              # Serve /public + rotas /play/totem e /play/:sessionId
│   └── swagger.js             # OpenAPI em /documentation
└── modules/
    ├── game/
    │   ├── game.routes.js     # WebSocket endpoint: /ws/game
    │   └── game.handler.js    # Lifecycle: connect, message, close, heartbeat
    ├── session/
    │   ├── session.routes.js  # REST read/end /api/sessions (criação é via fila)
    │   ├── session.repository.js  # MongoDB CRUD (sessão por-jogador)
    │   └── session.cache.js   # Redis HASH cache
    ├── totem/
    │   ├── totem.routes.js    # REST /api/totems: CRUD + fila + SSE
    │   ├── totem.service.js   # CRUD de totem (apenas)
    │   ├── totemQueue.service.js  # DONO do ciclo fila→sessão→vaga (mutex por totem)
    │   └── totem.repository.js    # MongoDB CRUD
    └── udp/
        └── udp.dispatcher.js  # Subscriber Redis game:input:* → envia UDP

tests/
└── e2e/queue.e2e.mjs          # npm run test:e2e — 8 cenários da fila (server real)

public/
├── index.html / dashboard.js      # Painel do operador (CRUD totens, sessões)
├── play.html / session.js         # Gamepad do jogador
├── gamepad.js                     # Handler de touch multi-touch
├── totem-entry.html / totem-entry.js  # Tela de fila do totem
└── websocket-client.js            # ArcadeWsClient com reconexão exponencial
```

---

## Ordem de Boot dos Plugins (`app.js`)

1. Static
2. Redis
3. MongoDB
4. WebSocket
5. Game Routes
6. Swagger
7. UDP
8. Session Routes
9. Totem Routes
10. **onReady**: inicia `UdpDispatcher`

`TotemQueueService` é criado e decorado (`fastify.totemQueue`) no registro das rotas de totem, junto com o sweeper. Não há mais dependência circular entre serviços.

---

## Variáveis de Ambiente

| Var | Obrigatória | Default | Descrição |
|-----|------------|---------|-----------|
| `MONGO_URI` | ✅ | — | URI do MongoDB |
| `REDIS_URL` | ✅ | — | URL do Redis |
| `UDP_HOST` | ✅ | — | Host UDP do totem |
| `UDP_PORT` | ✅ | — | Porta UDP do totem |
| `PORT` | ❌ | 3000 | Porta HTTP |
| `HOST` | ❌ | 0.0.0.0 | Bind address |
| `NODE_ENV` | ❌ | development | Ambiente |
| `SESSION_TIMEOUT_MS` | ❌ | 300000 | Fallback de duração de jogo (ms) |
| `SESSION_MAX_PLAYERS` | ❌ | 2 | Fallback de vagas por totem |
| `PUBLIC_URL` | ❌ | http://localhost:3000 | URL base para QR codes |
| `QUEUE_RESERVE_MS` | ❌ | 30000 | Prazo do chamado da fila conectar |
| `QUEUE_SWEEP_MS` | ❌ | 10000 | Intervalo do sweeper (no_show/timeout) |
| `QUEUE_JOIN_RATE_MAX` | ❌ | 8 | Máx. de queue/join por IP a cada 10s |

Em `development`, Redis/MongoDB indisponíveis geram warning (não fatal). Em `production`, falham na inicialização.

---

## APIs REST

### Sessions `/api/sessions`

Sessões são criadas SOMENTE pelo fluxo de fila (`queue/join`) — não há rota de criação.

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/sessions` | Lista sessões vivas (reserved/active) |
| GET | `/api/sessions/:id` | Detalha sessão (inclui totemId, playerId, status) |
| POST | `/api/sessions/:id/end` | Encerra a sessão do jogador (vaga libera, fila anda) |
| POST | `/api/sessions/:id/players/:playerId/kick` | Idem end, com reason 'kicked' (compat dashboard) |
| DELETE | `/api/sessions/:id` | Hard-delete (admin) |
| GET | `/api/sessions/:id/qr` | QR code PNG ou data URL |

**Sweeper**: roda a cada `QUEUE_SWEEP_MS` (10s) — expira reservas não reclamadas (`no_show`, 30s) e sessões ativas fora do tempo (`timeout`), avançando a fila.

### Totems `/api/totems`

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/totems` | Cria totem |
| GET | `/api/totems` | Lista todos (com tamanho de fila) |
| GET | `/api/totems/:id` | Detalha totem |
| PUT | `/api/totems/:id` | Atualiza totem |
| DELETE | `/api/totems/:id` | Remove totem (encerra sessões + limpa fila antes) |
| GET | `/api/totems/:id/qr` | QR code permanente do totem |
| POST | `/api/totems/:id/queue/join` | Sessão própria (`play`) ou fila (`queue`) — rate-limited |
| GET | `/api/totems/:id/queue/status` | `play`+sessionId se foi chamado; senão posição+ETA |
| GET | `/api/totems/:id/queue` | Visão do operador: sessões vivas + fila |
| GET | `/api/totems/:id/queue/events` | SSE — ping quando a fila muda |
| DELETE | `/api/totems/:id/queue/:playerId` | Remove jogador da fila |
| POST | `/api/totems/:id/queue/clear` | Limpa SÓ a lista de espera |
| POST | `/api/totems/:id/end-session` | Com `{playerId}` (aceita pid truncado 8 chars): encerra a sessão daquele jogador (morte no jogo). Sem body: encerra TODAS (reset) |

### WebSocket

| Rota | Params | Descrição |
|------|--------|-----------|
| `/ws/game` | `?sessionId=&playerId=` | Conexão do jogador ao jogo |

**Heartbeat**: ping a cada 15s, encerra se sem pong em 30s.

### Outros

- `GET /health` → `{ status: 'ok', ts }`
- `GET /documentation` → Swagger UI
- `GET /play/totem` → `totem-entry.html` (QR permanente)
- `GET /play/:sessionId` → `play.html`

---

## Schemas MongoDB

### Collection `sessions`

**Uma sessão = UM jogador em UM totem.** Totem de N jogadores = até N sessões vivas.

```js
{
  _id: UUID,
  totemId: UUID,
  playerId: String,             // dono único da sessão
  status: 'reserved' | 'active' | 'finished',
  totems: [{ id, ip, udpPort }],// endereço UDP (lido pelo dispatcher)
  metadata: { ua, ip, ... } | null,
  gameDurationMs: Number,       // tempo de jogo (do totem)
  createdAt: Date,
  reservedUntil: Date,          // prazo de 30s p/ conectar (QUEUE_RESERVE_MS)
  expiresAt: Date,              // fim do tempo de jogo (resetado no claim)
  endedAt: Date | null,
  endReason: 'died'|'kicked'|'timeout'|'no_show'|'manual'|null
}
```
Índices: `{ status: 1 }`, `{ expiresAt: 1 }`, `{ totemId: 1, status: 1 }`.

### Collection `totems`
```js
{
  _id: UUID,
  name: String,
  ip: String,
  udpPort: Number,
  maxPlayers: Number,           // vagas simultâneas (default: 2)
  sessionDurationMs: Number,    // default: 1800000 (30min)
  maxQueueSize: Number | null,  // cap da fila (null = ilimitada)
  createdAt: Date,
  updatedAt: Date
}
```

---

## Redis Keys

| Key | Tipo | Descrição |
|-----|------|-----------|
| `session:{sessionId}` | HASH | Cache da sessão (id, totemId, playerId, status, totems JSON, expiresAt) |
| `queue:totem:{totemId}` | LIST | Fila de playerIds do totem |
| `queue:heartbeat:{playerId}` | STRING | "1" com TTL 120s — mantém presença na fila |
| `player:metadata:{playerId}` | STRING | JSON com dispositivo/IP (TTL 120s) |

Canal extra Pub/Sub: `queue:event:{totemId}` — ping "queue_changed" para SSE.

---

## Canais Redis Pub/Sub (`src/lib/channels.js`)

| Canal | Publisher | Subscriber | Payload |
|-------|-----------|-----------|---------|
| `game:input:{sessionId}` | game.handler (WS) | udp.dispatcher | `{ type:'input', sessionId, playerId, data:{action,state}, ts }` |
| `game:event:{sessionId}` | session.service | Frontend WS | `{ type:'event', ... }` |
| `session:sync:{sessionId}` | game.handler | Frontend WS | `{ type:'sync', ... }` (player joined/left) |

---

## Pacotes UDP (Totem)

Formato JSON < 512 bytes. **Inputs** (dispatcher → jogo):
```js
{
  sid: string,  // Primeiros 8 chars do sessionId
  pid: string,  // Primeiros 8 chars do playerId
  a: string,    // Action: "btn_A", "dpad_up", etc.
  s: 0 | 1,    // State: 0=released, 1=pressed
  ts: number   // Últimos 7 dígitos do timestamp
}
```

**Lifecycle** (backend → jogo):
```js
{ type: 'player_join',  sid, pid, tid }  // jogador conectou (WS claim)
{ type: 'player_leave', sid, pid, tid }  // sessão encerrou — remover avatar
```
`pid` sempre truncado a 8 chars — o jogo indexa jogadores por esse valor, e o
backend resolve por prefixo quando o jogo reporta morte (`end-session`).

---

## State Machine de Sessão

```
reserved ──(WS conecta / claim)──► active ──(morte/kick/timeout)──► finished
reserved ──(30s sem conectar → no_show / kick)────────────────────► finished
```
Sessões `finished` persistem no banco (não são deletadas automaticamente).

**Fila**: quando qualquer sessão encerra, `TotemQueueService._advanceLocked()`
puxa o próximo jogador vivo da fila e cria uma sessão `reserved` pra ele.
Todo o ciclo é serializado por mutex por-totem (`src/lib/mutex.js`).

---

## Fluxo Completo do Jogador

```
1. Jogador escaneia QR do totem → GET /play/totem?id={totemId}
2. totem-entry.js: gera playerId (sessionStorage) → POST /api/totems/:id/queue/join
   - Vaga livre e fila vazia: sessão própria criada (reserved) → redirect /play/:sessionId
   - Senão: fila — polling queue/status a cada 3s + SSE queue/events (push)
3. play.html: session.js valida sessão via GET /api/sessions/:id
4. Conecta WebSocket: /ws/game?sessionId=&playerId=
5. game.handler: CLAIM da sessão (reserved → active, relógio de jogo inicia),
   envia UDP player_join ao jogo
6. Jogador pressiona botão → gamepad.js → WS → game.handler.onMessage
7. game.handler publica no Redis: game:input:{sessionId}
8. udp.dispatcher recebe, resolve IPs do totem, envia UDP
9. Jogador morre → jogo chama POST /api/totems/:id/end-session {playerId}
   → SÓ a sessão dele encerra (UDP player_leave) → fila anda → próximo entra
10. Celular do morto: tela "Sua sessão acabou" + botão "Jogar novamente"
    (volta pra entrada do totem, fim da fila)
```

---

## Padrões de Design

- **Plugin Architecture** — separação de concerns via plugins Fastify
- **Service/Repository** — lógica de negócio separada do acesso a dados
- **Factory Pattern** — `buildApp()` para app testável
- **3-Layer Caching** — in-memory → Redis HASH → MongoDB
- **Circular Dependency Injection** — SessionService ↔ TotemService wired no `onReady`
- **Graceful Degradation** — Redis/MongoDB opcionais em dev
- **Soft TTL** — expiresAt no documento; watcher remove manualmente
- **Exponential Backoff** — reconexão WebSocket (1s → 2s → 4s … max 30s)

---

## Frontend

### Páginas

| Arquivo | URL | Usuário |
|---------|-----|---------|
| `index.html` | `/` | Operador — CRUD totens/sessões |
| `play.html` | `/play/:sessionId` | Jogador — gamepad touch |
| `totem-entry.html` | `/play/totem?id=` | Jogador — fila do totem |

### Gamepad (`gamepad.js`)
- Multi-touch simultâneo (D-Pad + botões de ação)
- Track por touch ID
- Vibração haptica ao pressionar
- Fallback mouse para desktop
- Botões: `dpad_up/down/left/right`, `btn_A/B/X/Y`

### ArcadeWsClient (`websocket-client.js`)
- Fila de envio offline (buffer enquanto desconectado)
- Reconexão automática com backoff exponencial
- Heartbeat ping a cada 15s
