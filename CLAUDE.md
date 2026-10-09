# Street Arcade Backend — Contexto do Projeto

## Design Context

Frontend UI work (`public/`) follows `PRODUCT.md` (strategy: users, purpose, brand personality) and `DESIGN.md` (visual system: colors, typography, components — "The Control Room" north star). Read both before touching operator dashboard, queue, or gamepad screens. Managed by the `impeccable` skill; run `/impeccable` for design commands (critique, audit, polish, live, etc.).

## Visão Geral

Backend Node.js + Fastify para um sistema de arcade real-time chamado **Street Arcade** (DreamBricks). Gerencia sessões de jogo via QR codes, conexões WebSocket para controles de jogo nos celulares dos jogadores, e comunicação UDP com totens de arcade físicos (máquinas Unity/C#).

**Fluxo central**: Jogador escaneia QR → entra na fila → recebe sessão → abre gamepad no celular → inputs WebSocket → Redis Pub/Sub → UDP → Totem.

**n→n (iframes)**: o mesmo totem pode ser incorporado em sites via `<iframe src="/embed/:totemId">`. Cada carregamento vira uma **instância** própria (fila, sessões, QR e celulares só dela) e o jogo roda no navegador do visitante, recebendo os inputs por SSE em vez de UDP. Regra de ouro: **configuração é do totem; fila/sessões/tempo real são da instância.** O totem físico é a instância `default`. Spec: `docs/superpowers/specs/2026-10-06-n-para-n-instancias-design.md`.

---

## Stack & Dependências Principais

- **Runtime**: Node.js ≥ 22 (Docker `node:22-alpine`), ES Modules (`"type": "module"`)
- **Framework**: Fastify 5.x
- **Banco**: MongoDB (`@fastify/mongodb`)
- **Cache/Pub-Sub**: Redis via ioredis (2 clientes separados: publisher + subscriber)
- **WebSocket**: `@fastify/websocket`
- **UDP**: Node.js `dgram` (send-only, sem bind)
- **QR Code**: `qrcode`
- **Logs**: Pino + pino-pretty
- **Docs**: `@fastify/swagger` + `@fastify/swagger-ui`
- **Dev**: `node --watch` (sem nodemon)
- **Qualidade**: ESLint 9 flat config (`npm run lint`, CI com `--max-warnings=0`), `node:test`, Playwright 1.63 (UI), GitHub Actions (`.github/workflows/ci.yml`)
- **Fontes**: Poppins (OFL) + IBM Plex Mono via Google Fonts. A Araboto do brandbook **não está licenciada**; os arquivos foram retirados do repositório (que é público). Veja `docs/design_system/assets/fonts/araboto/LICENSE.md`. **Nunca commitar arquivos de fonte** (o `.gitignore` bloqueia).

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
│   ├── mutex.js               # Mutex por chave (serializa fila por instância)
│   ├── rateLimit.js           # Rate limiter fixed-window por IP: Redis (compartilhado entre processos) ou memória
│   ├── envCheck.js            # Regras de prontidão do .env de produção (boot + npm run ops:check-env)
│   ├── auth.js                # Cookie HMAC do operador, comparação constante, chave do totem
│   ├── instances.js           # Registro das instâncias web em memória (dev sem Redis)
│   ├── instances.redis.js     # Registro das instâncias no Redis (multi-processo, sobrevive a restart)
│   ├── stats.js               # Agregação pura do histórico (por totem ou do evento) + rankingSince
│   ├── nicknames.js           # Apelidos "Capivara Veloz": listas padrão + sorteio sem repetir na tela
│   ├── passwords.js           # scrypt das senhas dos usuários do painel
│   ├── csv.js                 # Planilha das sessões (; + BOM, fórmulas neutralizadas)
│   ├── inputs.js              # Ações válidas do gamepad + token bucket por socket
│   └── games.js               # Jogos incorporáveis + config.schema.json (formulário e validação do gameConfig)
├── plugins/
│   ├── auth.js                # Login do operador + guarda das rotas (config.operator) — registrado PRIMEIRO
│   ├── redis.js               # fastify.redisPublisher + fastify.redisSubscriber
│   ├── mongodb.js             # Conexão + criação de índices
│   ├── websocket.js           # Registro do @fastify/websocket (max payload 512b)
│   ├── udp.js                 # fastify.udpSend(ip, port, msg) — socket dgram
│   ├── static.js              # Serve /public + rotas /play/totem e /play/:sessionId
│   └── swagger.js             # OpenAPI em /documentation
└── modules/
    ├── game/
    │   ├── game.routes.js     # WebSocket endpoint: /ws/game
    │   ├── game.handler.js    # Lifecycle: connect, message, close, heartbeat
    │   └── game.output.js     # ÚNICO ponto que entrega pacote ao jogo: UDP (default) ou SSE (iframe)
    ├── operator/
    │   └── operator.routes.js # SSE único do painel (/api/operator/events) + fastify.opsNotify()
    ├── users/
    │   └── users.routes.js    # Contas do painel (/api/users) + registro de atividade (/api/audit); fastify.users, fastify.audit
    ├── settings/
    │   └── settings.routes.js # Listas de apelidos (/api/settings/nicknames); fastify.settings
    ├── instance/
    │   └── instance.hub.js    # Streams SSE DESTE processo + entrega via Redis inst:out:* (o "socket UDP" do iframe)
    ├── embed/
    │   └── embed.routes.js    # /embed/:totemId[/:instanceId/*] — serve o jogo + contrato da ponte
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
        └── udp.dispatcher.js  # Subscriber Redis game:input:* → GameOutput (UDP ou SSE)

tests/
├── unit/*.test.mjs            # npm run test:unit — instâncias, auth (inclui canonicalPath), stats, inputs, rateLimit, envCheck
├── e2e/queue.e2e.mjs          # npm run test:e2e — 9 cenários: fila (totem físico) + health/ready e retenção
├── e2e/instances.e2e.mjs      # 10 cenários n→n (iframes), validação de inputs, stream do operador
├── e2e/auth.e2e.mjs           # 9 cenários: login (e caminhos codificados), chave do totem, ops:totem-keys, queue-state público, histórico
├── e2e/cluster.e2e.mjs        # 4 cenários: 2 processos, restart no meio da partida, limite de login do cluster
├── e2e/bridges.e2e.mjs        # 8 cenários: pontes locais (snake, brick-rush) contra backend falso
├── e2e/features.e2e.mjs       # 6 cenários: apelidos, ranking, pausa, planilha/evento, formulário do jogo
└── ui/*.spec.mjs              # npm run test:ui — Playwright: painel, celular (Pixel 7), embed

.github/workflows/ci.yml       # lint + unit → e2e + UI (mongo/redis) + checagens da imagem Docker

public/
├── css/tokens.css + components.css    # DreamBricks Design System (fonte: docs/design_system)
├── css/dashboard.css                  # Shell do painel (porte do ui_kits/dashboard do DS)
├── assets/brand/                      # Marca DreamBricks + mascote J0Bson
├── embed-assets/overlay.{js,css}      # Cartão de QR injetado sobre o jogo incorporado
├── login.html                     # Login do operador: usuário + senha (split-screen do UI kit)
├── index.html / dashboard.js      # Painel do operador: sidebar + stats + cards, histórico, dialogs nativos
├── dashboard-views.js             # Seções #evento, #apelidos, #usuarios, #atividade (navegação por hash)
├── turn-alert.js + sw.js          # "É a sua vez!": som, vibração, título e notificação (service worker)
├── player-store.js                # playerId com validade (localStorage 10 min) p/ fila e controle
├── play.html / session.js         # Gamepad do jogador
├── gamepad.js                     # Handler de touch multi-touch
├── totem-entry.html / totem-entry.js  # Tela de fila do totem (aceita ?instance=)
└── websocket-client.js            # ArcadeWsClient com reconexão exponencial

games/                               # Jogos browser; servidos pelo backend em /embed (URLs RELATIVAS)
├── shared/static.js                 # Arquivos estáticos das pontes: só dentro de public/ (+ marca do repo)
└── */server.js                      # Ponte local do totem físico (UDP → SSE); BRIDGE_HTTP_PORT/BRIDGE_UDP_PORT

scripts/
├── check-env.mjs                    # npm run ops:check-env [arquivo] — .env pronto para produção?
└── totem-keys.mjs                   # npm run ops:totem-keys [--apply] — totens sem chave do jogo

.env.production.example              # Modelo do .env de produção
```

---

## Ordem de Boot dos Plugins (`app.js`)

0. Auth (`onRequest` global: `config.operator`, `/` → `/login`, Swagger em produção)
1. Static
2. Redis
3. MongoDB
4. WebSocket
5. Game Routes
6. Swagger
7. UDP
7.5. Instâncias: `fastify.instances` (Redis se disponível, senão memória), `instanceHub` (SSE local + `listen` em `inst:out:*`), `gameOutput` (UDP ou SSE via Redis)
8. Session Routes
9. Totem Routes (+ sweeper de sessões e de instâncias)
9.2. Operator Routes (`/api/operator/events`, `fastify.opsNotify`)
9.5. Embed Routes (`/embed/*`)
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
| `SESSION_RETENTION_DAYS` | ❌ | 90 | Sessões encerradas são apagadas (índice TTL em `endedAt`); 0 = nunca |
| `PUBLIC_URL` | ❌ | http://localhost:3000 | URL base para QR codes (https → cookie `Secure`) |
| `OPERATOR_PASSWORD` | ✅ em produção | — | Senha do painel/API de operação. Vazia em dev = sem login |
| `QUEUE_RESERVE_MS` | ❌ | 30000 | Prazo do chamado da fila conectar |
| `QUEUE_SWEEP_MS` | ❌ | 10000 | Intervalo do sweeper (no_show/timeout) |
| `QUEUE_JOIN_RATE_MAX` | ❌ | 8 | Máx. de queue/join por IP a cada 10s |
| `INSTANCE_GRACE_MS` | ❌ | 120000 | Folga antes de encerrar instância (iframe) sem SSE |
| `MAX_INSTANCES_PER_IP` | ❌ | 20 | Iframes simultâneos por IP (loopback não conta) |
| `MAX_INSTANCES_PER_TOTEM` | ❌ | 2000 | Iframes simultâneos por totem |
| `TRUST_PROXY` | ❌ | false | Usar `X-Forwarded-For` para o IP do visitante (Fastify `trustProxy` + limites por IP) |
| `EMBED_FRAME_ANCESTORS` | ❌ | `*` | Valor do `frame-ancestors` (CSP) em `/embed/*` |
| `GAMES_DIR` | ❌ | `./games` | Pasta dos jogos servidos no embed |

Em `development`, Redis/MongoDB indisponíveis geram warning (não fatal). Em `production`, falham na inicialização — e `OPERATOR_PASSWORD` é obrigatória.

**Docker**: `node:22-alpine`; a imagem leva `games/` (o `/embed` serve `games/*/public`) e tem `HEALTHCHECK` em `/health/ready`. Atrás do nginx, use `TRUST_PROXY=true` (em produção o servidor avisa no log se receber `X-Forwarded-For` sem ela).

---

## APIs REST

### Autenticação

**Operador** = cookie `sa_op=<exp>.<sujeito>.<hmac>` (HMAC derivado de `OPERATOR_PASSWORD`, 12h) ou `Authorization: Bearer <OPERATOR_PASSWORD>`. Sujeito `admin` (senha do servidor) ou `<userId>:<tokenVersion>` (conta da collection `users`; trocar senha/desativar incrementa `tokenVersion` e derruba os cookies). `request.operator = { id, username, name, role }`. Rotas com `config: { operator: true }` devolvem `401` sem isso; `config.role: 'admin'` devolve `403` para operador comum; `/` redireciona para `/login`.
**Atividade**: todo POST/PUT/DELETE bem-sucedido de operador em `/api/*` vai para a collection `audit` (hook `onResponse`; nome da ação em `config.audit`, corpo sem segredos), além de login/logout/login errado.
**Jogo/ponte física** = header `X-Totem-Key: <totem.gameKey>` em `end-session` e `GET /api/totems/:id/queue`. Totem legado sem `gameKey`: morte por jogador aberta, reset exige operador.
**Públicas**: tudo do jogador (`queue/join|status|events`, `GET /api/sessions/:id`, QRs, `/ws/game`, `/play/*`, `/embed/*`).

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/login` | Tela de login |
| POST | `/api/auth/login` | `{ username?, password }` → cookie (10 tentativas/min por IP). Usuário vazio ou `admin` = `OPERATOR_PASSWORD` |
| POST | `/api/auth/logout` | Apaga o cookie |
| GET | `/api/auth/me` | `{ operator, authEnabled, user }` |
| GET/POST | `/api/users` | 👑 Lista / cria conta `{ username, name, role: admin\|operator, password ≥10 }` |
| PUT/DELETE | `/api/users/:id` | 👑 Edita (`name, role, disabled, password`) / exclui. Ninguém se desativa, rebaixa ou exclui |
| GET | `/api/audit` | 👑 Atividade `?limit&before=<ISO>&username&action=<prefixo>` |
| GET | `/api/settings/nicknames` | 🔒 Listas de apelidos + 6 exemplos sorteados |
| PUT | `/api/settings/nicknames` | 👑 `{ animals, adjectives }` ou `{ reset: true }` |

👑 = só administrador (`403` para operador comum)

### Sessions `/api/sessions`

Sessões são criadas SOMENTE pelo fluxo de fila (`queue/join`) — não há rota de criação.

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/sessions` | 🔒 Lista sessões vivas (reserved/active) |
| GET | `/api/sessions/:id` | Detalha sessão (inclui totemId, playerId, status) |
| POST | `/api/sessions/:id/end` | 🔒 Encerra a sessão do jogador (vaga libera, fila anda) |
| POST | `/api/sessions/:id/players/:playerId/kick` | 🔒 Idem end, com reason 'kicked' (compat dashboard) |
| DELETE | `/api/sessions/:id` | 🔒 Hard-delete (admin) |
| GET | `/api/sessions/:id/qr` | QR code PNG ou data URL |

**Sweeper**: roda a cada `QUEUE_SWEEP_MS` (10s) — expira reservas não reclamadas (`no_show`, 30s) e sessões ativas fora do tempo (`timeout`), avançando a fila.

### Totems `/api/totems`

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/totems` | 🔒 Cria totem (gera `gameKey`) |
| GET | `/api/totems` | 🔒 Lista todos (com tamanho de fila e `gameKey`) |
| GET | `/api/totems/:id` | 🔒 Detalha totem |
| PUT | `/api/totems/:id` | 🔒 Atualiza totem |
| DELETE | `/api/totems/:id` | 🔒 Remove totem (encerra sessões + limpa fila antes) |
| POST | `/api/totems/:id/game-key` | 🔒 Gera nova chave do jogo (a antiga para na hora) |
| GET | `/api/totems/:id/stats` | 🔒 Histórico `?range=24h\|7d\|30d&tz=<getTimezoneOffset>` |
| GET | `/api/totems/:id/qr` | QR code permanente do totem |
| POST | `/api/totems/:id/queue/join` | Sessão própria (`play`) ou fila (`queue`) — rate-limited |
| GET | `/api/totems/:id/queue/status` | `play`+sessionId se foi chamado; senão posição+ETA |
| GET | `/api/totems/:id/queue` | 🔒/🔑 Visão do operador: sessões vivas + fila (operador ou `X-Totem-Key`) |
| GET | `/api/totems/:id/queue/events` | SSE — ping quando a fila muda |
| DELETE | `/api/totems/:id/queue/:playerId` | 🔒 Remove jogador da fila |
| POST | `/api/totems/:id/queue/clear` | 🔒 Limpa SÓ a lista de espera |
| POST | `/api/totems/:id/end-session` | 🔑 Com `{playerId, score?}` (aceita pid truncado 8 chars): encerra a sessão daquele jogador (morte no jogo) e guarda os pontos. Sem body: encerra TODAS da instância (reset) |
| POST | `/api/totems/:id/pause` | 🔒 `{ paused }` — pausado: join → `423`, a fila não anda, quem joga termina; retomar chama a fila de todas as instâncias |
| GET | `/api/totems/:id/ranking` | 🔑 Melhores pontuações `?range=24h\|7d\|30d\|all&limit` |
| GET | `/api/ranking` | 🔒 Ranking de todos os totens (com `totemName`) |
| GET | `/api/stats` | 🔒 Histórico do evento inteiro + `byTotem` |
| GET | `/api/totems/:id/sessions.csv` · `/api/sessions.csv` | 🔒 Planilha das sessões `?range=` |
| GET | `/api/games/:game/config-schema` | 🔒 Formulário dos ajustes do jogo (`games/<jogo>/config.schema.json`) |
| GET | `/api/totems/:id/instances` | 🔒 `default` + iframes abertos, com nº de sessões e fila |
| GET | `/api/games` | 🔒 Jogos incorporáveis (pastas de `games/`) |
| GET | `/api/operator/events` | 🔒 SSE do painel: `state` (retrato), `totem` (só o que mudou), `totems_changed` |

🔒 = operador · 🔑 = operador ou `X-Totem-Key`

Todas as rotas de fila (`queue/*`, `end-session`, `qr`) aceitam `?instance=<id>`; sem ele = instância `default` (totem físico). Instância web fechada → `410`.

### Embed `/embed` (n→n)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/embed/:totemId` | 302 para `/embed/:totemId/<uuid novo>/` (uma instância por carregamento; preserva query) |
| GET | `/embed/:totemId/:inst/` | `index.html` do jogo com o overlay de QR injetado |
| GET | `/embed/:totemId/:inst/events` | SSE com `connected`, `init`, `player_join`, inputs, `player_leave` (429 se limite) |
| POST | `/embed/:totemId/:inst/end-session` | `{ pid, score? }` — jogador morreu nesta instância |
| GET | `/embed/:totemId/:inst/queue-state` | HUD público: `{ sessions:[{pid,name,status}], queue:[{position}], maxPlayers, paused }` (sem IP/UA) |
| GET | `/embed/:totemId/:inst/ranking` | Placar público do totem: `[{ position, name, score }]` |
| GET | `/embed/:totemId/:inst/config` | `{ debugPanel: false, ...totem.gameConfig }` |
| GET | `/embed/:totemId/:inst/*` | Estáticos de `games/<totem.game>/public` |

Query do iframe: `showqr=false`, `qrpos=br|bl|tr|tl`, `qrmin=true`.

### WebSocket

| Rota | Params | Descrição |
|------|--------|-----------|
| `/ws/game` | `?sessionId=&playerId=` | Conexão do jogador ao jogo |

**Heartbeat**: ping a cada 15s, encerra se sem pong em 30s. O `{type:'ping'}` JSON do cliente recebe `{type:'pong'}`.

**Validação** (`src/lib/inputs.js`): só as 8 ações do gamepad (`dpad_up|down|left|right`, `btn_A|B|X|Y`) com `pressed|released`; 30 inputs/s por socket (rajadas de 40). Mais de 200 mensagens recusadas em 10 s fecha o socket (1008).

### Outros

- `GET /health` → `{ status: 'ok', ts }` (liveness)
- `GET /health/ready` → `{ status, mongo, redis }`, 503 se Mongo ou Redis não respondem (readiness, Docker HEALTHCHECK)
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
  instanceId: String,           // 'default' (totem físico) ou id do iframe; docs antigos sem campo = default
  playerId: String,             // dono único da sessão
  nickname: String | null,      // apelido sorteado ("Capivara Veloz") — celular, jogo (nm), ranking
  score: Number | null,         // pontos enviados pelo jogo no end-session (ranking)
  status: 'reserved' | 'active' | 'finished',
  totems: [{ id, ip, udpPort }],// endereço UDP (lido pelo dispatcher)
  metadata: { ua, ip, ... } | null,
  gameDurationMs: Number,       // tempo de jogo (do totem)
  queuedAt: Date | null,        // entrou na fila (null = jogou direto) — histórico
  startedAt: Date | null,       // celular conectou (reserved → active)
  site: String | null,          // origem do site que incorporou o iframe ('preview' = painel)
  createdAt: Date,
  reservedUntil: Date,          // prazo de 30s p/ conectar (QUEUE_RESERVE_MS)
  expiresAt: Date,              // fim do tempo de jogo (resetado no claim)
  endedAt: Date | null,
  endReason: 'died'|'kicked'|'timeout'|'no_show'|'manual'|'instance_closed'|null
}
```
Índices: `{ status: 1 }`, `{ expiresAt: 1 }`, `{ totemId: 1, status: 1 }`, `{ totemId: 1, instanceId: 1, status: 1 }`, `{ totemId: 1, createdAt: -1 }` (histórico), `{ endedAt: 1 }` TTL `sessions_finished_ttl` (`SESSION_RETENTION_DAYS`), `sessions_totem_score` / `sessions_score` (parciais, só com `score` numérico — ranking).

### Collection `totems`
```js
{
  _id: UUID,
  name: String,
  ip: String | null,            // só totem físico
  udpPort: Number | null,
  game: String | null,          // pasta em games/ servida no embed (null = não incorporável)
  gameConfig: Object | null,    // devolvido ao jogo em /embed/.../config
  maxPlayers: Number,           // vagas simultâneas (default: 2)
  sessionDurationMs: Number,    // default: 1800000 (30min)
  maxQueueSize: Number | null,  // cap da fila (null = ilimitada)
  gameKey: String | null,       // X-Totem-Key do jogo/ponte (null em totens antigos)
  paused: Boolean,              // entrada fechada (manutenção/intervalo)
  pausedAt: Date | null, pausedBy: String | null,
  createdAt: Date,
  updatedAt: Date
}
```

### Collections `users`, `audit`, `settings`
```js
users:    { _id, username (único, minúsculo), name, role: 'admin'|'operator', passwordHash (scrypt),
            tokenVersion, disabled, createdAt, updatedAt, lastLoginAt }
audit:    { at, userId, username, name, action, method, url, target, status, details, ip }  // TTL 180 dias
settings: { _id: 'nicknames', animals: [], adjectives: [], updatedAt, updatedBy }          // sem doc = listas padrão
```

---

## Redis Keys

| Key | Tipo | Descrição |
|-----|------|-----------|
| `session:{sessionId}` | HASH | Cache da sessão (id, totemId, playerId, status, totems JSON, expiresAt) |
| `queue:totem:{totemId}` | LIST | Fila de playerIds do totem físico (instância default) |
| `queue:totem:{totemId}:{instanceId}` | LIST | Fila de cada iframe |
| `queue:heartbeat:{playerId}` | STRING | "1" com TTL 120s — mantém presença na fila |
| `player:metadata:{playerId}` | STRING | JSON com dispositivo/IP (TTL 120s) |
| `queue:joined:{playerId}` | STRING | Quando entrou na fila (ms) → `session.queuedAt` (TTL 6h) |
| `player:nick:{playerId}` | STRING | Apelido sorteado na entrada (TTL 6h) — o mesmo na fila, na sessão e no jogo |
| `inst:{totemId}` | HASH | instanceId → `{ ip, createdAt, lastSeenAt, onlineUntil }` (registro das instâncias web) |
| `inst:ip:{ip}` | SET | `totemId\|instanceId` — limite por IP |
| `inst:totems` | SET | totens com instâncias (índice do sweep) |
| `inst:sweep-lock` | STRING | um sweeper por vez entre processos |
| `inst:site:{totemId}:{instanceId}` | STRING | origem do site que incorporou (TTL 24h) |
| `rl:{name}:{ip}:{janela}` | STRING | contador do limitador por IP (`queue-join`, `login`), expira com a janela |

Canais extras Pub/Sub: `queue:event:{totemId}[:{instanceId}]` — ping "queue_changed" (join/saída/avanço/claim/fim de sessão) para os SSE da fila e do painel; `inst:out:{totemId}:{instanceId}` — pacote do jogo para o processo que tem o SSE do iframe; `ops:totem:{totemId}` / `ops:totems` — iframe aberto/fechado e CRUD de totem (stream do operador).

---

## Canais Redis Pub/Sub (`src/lib/channels.js`)

| Canal | Publisher | Subscriber | Payload |
|-------|-----------|-----------|---------|
| `game:input:{sessionId}` | game.handler (WS) | udp.dispatcher | `{ type:'input', sessionId, playerId, data:{action,state}, ts }` |
| `game:event:{sessionId}` | totemQueue.service (`session_ended`) | game.handler (repassa ao WS do celular) e udp.dispatcher | `{ type:'event', data:{ event, reason } }` |
| `session:sync:{sessionId}` | game.handler | (nenhum hoje — publicado para uso futuro) | `{ type:'sync', ... }` (player connected/disconnected) |

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
{ type: 'player_join',  sid, pid, tid, nm }  // jogador conectou (WS claim); nm = apelido
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
Sessões `finished` ficam no banco por `SESSION_RETENTION_DAYS` (90) e depois o índice TTL as apaga.

**Fila**: quando qualquer sessão encerra, `TotemQueueService._advanceLocked()`
puxa o próximo jogador vivo da fila e cria uma sessão `reserved` pra ele.
Todo o ciclo é serializado por mutex por-totem (`src/lib/mutex.js`).

---

## Fluxo Completo do Jogador

```
1. Jogador escaneia QR do totem → GET /play/totem?id={totemId}
2. totem-entry.js: gera playerId (player-store.js: localStorage 10 min) → POST /api/totems/:id/queue/join
   - Vaga livre e fila vazia: sessão própria criada (reserved) → redirect /play/:sessionId
   - Senão: fila — polling queue/status a cada 3s + SSE queue/events (push)
3. play.html: session.js valida sessão via GET /api/sessions/:id
4. Conecta WebSocket: /ws/game?sessionId=&playerId=
5. game.handler: CLAIM da sessão (reserved → active, relógio de jogo inicia),
   envia UDP player_join ao jogo
6. Jogador pressiona botão → gamepad.js → WS → game.handler.onMessage
7. game.handler publica no Redis: game:input:{sessionId}
8. udp.dispatcher recebe, resolve IPs do totem, envia UDP
9. Jogador morre → jogo chama POST /api/totems/:id/end-session {playerId, score} (header X-Totem-Key)
   → SÓ a sessão dele encerra (UDP player_leave) → fila anda → próximo entra
10. Celular do morto: tela "Sua sessão acabou" + botão "Jogar novamente"
    (volta pra entrada do totem, fim da fila)
```

---

## Padrões de Design

- **Plugin Architecture** — separação de concerns via plugins Fastify
- **Service/Repository** — lógica de negócio separada do acesso a dados
- **Factory Pattern** — `buildApp()` para app testável
- **Multi-processo** — registro de instâncias no Redis; pacotes de iframe via `inst:out:*`; o dispatcher só repassa inputs de celulares conectados no PRÓPRIO processo (sem duplicar com N réplicas); sweeper com lock
- **Session cache** — Redis HASH `session:{id}` (a sessão em si vive no MongoDB)
- **Graceful Degradation** — Redis/MongoDB opcionais em dev
- **Soft TTL** — `expiresAt`/`reservedUntil` no documento; o sweeper encerra (`timeout`/`no_show`). Sessões encerradas somem pelo índice TTL (`SESSION_RETENTION_DAYS`)
- **Exponential Backoff** — reconexão WebSocket (1s → 2s → 4s … max 30s)

---

## Frontend

### Páginas

| Arquivo | URL | Usuário |
|---------|-----|---------|
| `login.html` | `/login` | Operador — usuário + senha |
| `index.html` | `/` | Operador — totens (pausar, fila, histórico, planilha, incorporar; atualiza pelo stream), `#evento`, `#apelidos`, `#usuarios`, `#atividade` |
| `play.html` | `/play/:sessionId` | Jogador — gamepad touch |
| `totem-entry.html` | `/play/totem?id=` | Jogador — fila do totem: apelido, aviso de pausa, "Me avise quando for a minha vez" |

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
