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
│   └── channels.js            # Nomes de canais Redis + builders de mensagem
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
    │   ├── session.routes.js  # REST CRUD /api/sessions
    │   ├── session.service.js # Lógica de negócio + state machine
    │   ├── session.repository.js  # MongoDB CRUD
    │   └── session.cache.js   # Redis HASH cache
    ├── totem/
    │   ├── totem.routes.js    # REST CRUD /api/totems + fila
    │   ├── totem.service.js   # Gestão de fila (Redis List) + ciclo de sessão
    │   └── totem.repository.js    # MongoDB CRUD
    └── udp/
        └── udp.dispatcher.js  # Subscriber Redis game:input:* → envia UDP

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
10. **onReady**: inicia `UdpDispatcher`, injeta dependências circulares (SessionService ↔ TotemService)

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
| `SESSION_TIMEOUT_MS` | ❌ | 300000 | TTL de sessão (ms) |
| `SESSION_MAX_PLAYERS` | ❌ | 2 | Máx. jogadores/sessão |
| `PUBLIC_URL` | ❌ | http://localhost:3000 | URL base para QR codes |

Em `development`, Redis/MongoDB indisponíveis geram warning (não fatal). Em `production`, falham na inicialização.

---

## APIs REST

### Sessions `/api/sessions`

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/sessions` | Cria sessão |
| GET | `/api/sessions` | Lista sessões ativas (não-finished) |
| GET | `/api/sessions/:id` | Detalha sessão |
| POST | `/api/sessions/:id/join` | Jogador entra (`{playerId}`) |
| POST | `/api/sessions/:id/end` | Encerra manualmente (aciona auto-renew) |
| DELETE | `/api/sessions/:id` | Hard-delete (admin) |
| GET | `/api/sessions/:id/qr` | QR code PNG ou data URL |

**Watcher de timeout**: polling a cada 30s, chama `endSession('timeout')` em sessões expiradas.

### Totems `/api/totems`

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/totems` | Cria totem |
| GET | `/api/totems` | Lista todos (com tamanho de fila) |
| GET | `/api/totems/:id` | Detalha totem |
| PUT | `/api/totems/:id` | Atualiza totem |
| DELETE | `/api/totems/:id` | Remove totem |
| GET | `/api/totems/:id/session` | Obtém/cria sessão ativa (legado) |
| GET | `/api/totems/:id/qr` | QR code permanente do totem |
| POST | `/api/totems/:id/queue/join` | Entra na fila ou recebe sessão direta |
| GET | `/api/totems/:id/queue/status` | Consulta posição na fila |
| POST | `/api/totems/:id/queue/clear` | Limpa fila |

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
```js
{
  _id: UUID,
  totemId: UUID | null,
  status: 'waiting' | 'active' | 'finished',
  totems: [{ id, ip, udpPort }],
  players: [{ id, connectedAt }],
  maxPlayers: Number,
  allowedPlayers: [String],
  createdAt: Date,
  expiresAt: Date,        // TTL soft — não auto-deleta no MongoDB
  endedAt: Date | null,
  endReason: 'timeout' | 'manual' | null
}
```
Índices: `{ status: 1 }`, `{ expiresAt: 1 }`.

### Collection `totems`
```js
{
  _id: UUID,
  name: String,
  ip: String,
  udpPort: Number,
  maxPlayers: Number,           // default: 2
  sessionDurationMs: Number,    // default: 1800000 (30min)
  currentSessionId: UUID | null,
  createdAt: Date,
  updatedAt: Date
}
```

---

## Redis Keys

| Key | Tipo | Descrição |
|-----|------|-----------|
| `session:{sessionId}` | HASH | Cache da sessão (id, status, maxPlayers, totems JSON, players JSON, expiresAt) |
| `queue:totem:{totemId}` | LIST | Fila de playerIds do totem |
| `queue:heartbeat:{playerId}` | STRING | "1" com TTL 120s — mantém presença na fila |

---

## Canais Redis Pub/Sub (`src/lib/channels.js`)

| Canal | Publisher | Subscriber | Payload |
|-------|-----------|-----------|---------|
| `game:input:{sessionId}` | game.handler (WS) | udp.dispatcher | `{ type:'input', sessionId, playerId, data:{action,state}, ts }` |
| `game:event:{sessionId}` | session.service | Frontend WS | `{ type:'event', ... }` |
| `session:sync:{sessionId}` | game.handler | Frontend WS | `{ type:'sync', ... }` (player joined/left) |

---

## Pacote UDP (Totem)

Formato JSON < 512 bytes:
```js
{
  sid: string,  // Primeiros 8 chars do sessionId
  pid: string,  // Primeiros 8 chars do playerId
  a: string,    // Action: "btn_A", "dpad_up", etc.
  s: 0 | 1,    // State: 0=released, 1=pressed
  ts: number   // Últimos 7 dígitos do timestamp
}
```

---

## State Machine de Sessão

```
waiting ──(1º jogador conecta via WS)──► active
active  ──(endSession / timeout)──────► finished
```
Sessões `finished` persistem no banco (não são deletadas automaticamente).

**Auto-renew**: ao terminar uma sessão associada a um totem, `TotemService.startNewSession()` é chamado automaticamente — cria nova sessão e desfileira os próximos jogadores da fila.

---

## Fluxo Completo do Jogador

```
1. Jogador escaneia QR do totem → GET /play/totem?id={totemId}
2. totem-entry.js: gera playerId (sessionStorage) → POST /api/totems/:id/queue/join
   - Se sessão disponível: redirect → /play/:sessionId
   - Se fila: polling GET /api/totems/:id/queue/status a cada 3s
3. play.html: session.js valida sessão via GET /api/sessions/:id
4. Conecta WebSocket: /ws/game?sessionId=&playerId=
5. game.handler: valida sessão, capacidade, registra socket
6. Jogador pressiona botão → gamepad.js → WS → game.handler.onMessage
7. game.handler publica no Redis: game:input:{sessionId}
8. udp.dispatcher recebe, resolve IPs do totem, envia UDP
9. Totem (Unity) processa input
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
