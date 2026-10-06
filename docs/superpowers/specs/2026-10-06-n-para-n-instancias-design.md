# Street Arcade n→n — instâncias por iframe + Design System DreamBricks

Data: 2026-10-06 · Status: aprovado (abordagem A) · Referência: `video_audio_sync_monolito/docs/campanhas-e-instancias.md`

## 1. Problema

Hoje o sistema é **1→n**: um totem físico roda UM jogo (browser local alimentado
por `games/*/server.js`, ponte UDP→SSE) e N celulares disputam as vagas desse
jogo via fila. Tudo (fila, mutex, sessões, canal SSE) é indexado só por `totemId`.

Queremos **n→n**: o mesmo totem incorporado como `<iframe>` em um site público;
cada visitante, em casa, tem **sua própria partida**, com QR, fila e celulares
próprios. Totens físicos continuam funcionando.

## 2. Conceitos

| Conceito | O que é | Onde vive |
|---|---|---|
| **Totem** (campanha) | Configuração: jogo, `maxPlayers`, duração, cap da fila, `gameConfig`, e (opcional) endereço UDP do totem físico | MongoDB `totems` |
| **Instância** | Um jogo rodando para um totem. `default` = totem físico (transporte UDP). Qualquer outro ID = um iframe (transporte SSE). Tem fila, sessões, QR e celulares **próprios** | Registro em memória (`src/lib/instances.js`) + sessões no MongoDB |

Regra de ouro: **configuração é do totem; fila/sessões/tempo real são da instância.**

## 3. Visão geral

```
 Site A (visitante 1)                 Backend (Fastify)
 ┌───────────────────────┐            ┌────────────────────────────────────────┐
 │ iframe                │──SSE──────►│ /embed/:totemId/:inst/events           │
 │ /embed/T/a1/          │            │   InstanceHub: inst → conexões SSE     │
 │  jogo (snake) + QR    │◄─inputs────│                                        │
 └───────────────────────┘            │ TotemQueueService (chave T:inst)       │
        QR (inst=a1)                  │   fila Redis / sessões Mongo           │
          ▼                           │                                        │
 Celular ─WS /ws/game────────────────►│ GameHandler → Redis game:input:{sid}   │
                                      │        │                               │
                                      │   GameOutput.send(session, packet)     │
                                      │     ├─ inst=default → UDP (totem físico)│
                                      │     └─ inst=a1      → InstanceHub SSE   │
                                      └────────────────────────────────────────┘
```

## 4. Modelo de dados

### `totems` (alterações)
```js
{
  ...existentes,
  game: 'snake' | 'brick-rush' | null,  // jogo servido no embed; null = não incorporável
  gameConfig: Object | null,            // devolvido em /config (ex.: { gameSpeed: 5 })
  ip: String | null,                    // agora OPCIONAL — só para totem físico
  udpPort: Number | null,               // obrigatório se ip informado
}
```
Validação: `game` ∈ lista de jogos em `games/` com `public/index.html`; ao menos
um entre `game` e `ip` deve existir.

### `sessions` (alterações)
- Novo campo `instanceId: String` (`'default'` para o físico).
- Documentos antigos sem o campo contam como `default` (filtros usam
  `instanceId: { $in: ['default', null] }` para `default`).
- Novo índice `{ totemId: 1, instanceId: 1, status: 1 }`.
- Novo `endReason`: `'instance_closed'`.
- `session.cache` (Redis HASH) passa a guardar `instanceId`.

### Redis
| Key | Mudança |
|---|---|
| `queue:totem:{totemId}` | continua sendo a fila da instância `default` (compat) |
| `queue:totem:{totemId}:{instanceId}` | **novo** — fila de cada instância web |
| `queue:event:{totemId}[:{instanceId}]` | canal SSE de fila, mesma regra |

Helper único `instanceKey(totemId, instanceId)` em `src/lib/channels.js` gera
o sufixo; mutex por-totem vira mutex por `totemId:instanceId`.

## 5. Registro de instâncias — `src/lib/instances.js`

Módulo puro, sem dependências, testável com relógio falso (porte do `lib/instances.js` da referência).

```js
const reg = createInstanceRegistry({ now, graceMs, maxPerIp, maxPerTotem })
reg.validId(id)                         // /^[A-Za-z0-9_-]{1,64}$/
reg.attach(totemId, instanceId, conn, ip) // SSE conectou → {ok, inst} | {ok:false, code:429}
reg.detach(inst, conn)                  // ignora conn antiga (reconexão já trocou)
reg.get(totemId, instanceId)            // inst | null
reg.isLive(totemId, instanceId)         // online ou dentro da folga
reg.list(totemId)                       // [{ id, online, connectedAt, lastSeenAt }]
reg.sweep()                             // devolve instâncias offline > graceMs e as remove
reg.totals()                            // { instances, online }
```

- `default` nunca entra no registro (sempre existe, transporte UDP).
- ID **gerado no servidor** no redirect de `/embed/:totemId` (`crypto.randomUUID()`), um por carregamento — evita a armadilha de iframes do mesmo site compartilharem `sessionStorage`.
- Reconectar uma instância conhecida é sempre permitido (não conta no limite).
- Limites: `MAX_INSTANCES_PER_IP` (20) e `MAX_INSTANCES_PER_TOTEM` (2000).
- IP via `X-Forwarded-For` só com `TRUST_PROXY=true`; sem isso, loopback não é limitado por IP (túnel ngrok).

## 6. Componentes no servidor

### 6.1 `GameOutput` — `src/modules/game/game.output.js` (novo)
Único ponto que entrega pacotes ao jogo:
```js
gameOutput.send(session, packet)  // packet = { type?, sid, pid, a?, s?, ts?, tid }
```
- `session.instanceId` ausente/`'default'` → `udpSend` para `session.totems` (comportamento atual).
- Senão → `instanceHub.push(totemId, instanceId, packet)`.

Usado por: `GameHandler.onConnect` (`player_join`), `TotemQueueService._sendPlayerLeave`
(`player_leave`) e `UdpDispatcher._handleMessage` (inputs). O `UdpDispatcher` mantém
a resolução de sessão (memória → Redis → Mongo) mas delega o envio ao `GameOutput`.

### 6.2 `InstanceHub` — `src/modules/instance/instance.hub.js` (novo)
- Guarda as respostas SSE abertas por instância (normalmente 1; aceita N).
- `push(totemId, instanceId, packet)` → `data: {json}\n\n` para todas.
- Keep-alive `: ping` a cada 15s.
- Formato dos pacotes **idêntico** ao que a ponte local entrega hoje — os jogos não mudam a lógica.

### 6.3 `TotemQueueService` (alterado)
Todas as operações recebem `instanceId` (default `'default'`):
`join(totemId, instanceId, playerId, meta)`, `status(...)`, `endSession`,
`endAllForInstance(totemId, instanceId, reason)`, `queueView(totemId, instanceId)`,
`_advanceLocked(totem, instanceId)`. Contagem de vagas, fila e mutex são por instância.
Para instância web, `join`/`status` retornam `410 { error: 'Essa tela foi fechada' }`
se `!registry.isLive(...)`.

### 6.4 Rotas de embed — `src/modules/embed/embed.routes.js` (novo)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/embed/:totemId` | 302 → `/embed/:totemId/:novoId/` (preserva query: `showqr`, `qrpos`) |
| GET | `/embed/:totemId/:inst/` | `index.html` do jogo com `<link>`/`<script>` do overlay injetados antes de `</body>` |
| GET | `/embed/:totemId/:inst/events` | SSE: `attach` no registro; envia `{type:'connected'}` e `{type:'init', totemId, instanceId}`; 429 se limite |
| POST | `/embed/:totemId/:inst/end-session` | `{ pid }` → encerra a sessão daquele jogador **nesta instância** |
| GET | `/embed/:totemId/:inst/queue-state` | mesmo payload de `GET /api/totems/:id/queue`, filtrado pela instância |
| GET | `/embed/:totemId/:inst/config` | `totem.gameConfig ?? {}` |
| GET | `/embed/:totemId/:inst/*` | estáticos de `games/<totem.game>/public` (path-traversal bloqueado) |
| GET | `/embed-assets/*` | `overlay.js` / `overlay.css` (de `public/embed-assets/`, servidos pelo static) |

Headers em `/embed/*`: `Content-Security-Policy: frame-ancestors <EMBED_FRAME_ANCESTORS>`
(default `*`), sem `X-Frame-Options`.

### 6.5 Rotas existentes (alteradas)
- `queue/join`, `queue/status`, `queue/events`, `DELETE queue/:playerId`, `queue/clear`,
  `end-session` aceitam `?instance=` (ausente → `default`).
- `GET /api/totems` → cada totem ganha `instances: { open, online }` e `playersOnline`.
- `GET /api/totems/:id/instances` (novo) → lista de instâncias com nº de sessões/fila.
- `POST/PUT /api/totems` aceitam `game`, `gameConfig`; `ip`/`udpPort` opcionais.
- `DELETE /api/totems/:id` também encerra todas as instâncias web (`instance_closed`).

### 6.6 Sweeper (alterado)
Além de `no_show`/`timeout`, a cada `QUEUE_SWEEP_MS`: `registry.sweep()` →
para cada instância expirada (`INSTANCE_GRACE_MS`, default 120000):
`endAllForInstance(..., 'instance_closed')` + apaga a fila Redis + publica evento.
Celulares recebem o fim da sessão pelo fluxo atual (tela "Sua sessão acabou").

## 7. Mudanças nos clientes

### Jogos (`games/snake`, `games/brick-rush`)
- Trocar URLs absolutas por relativas: `'/events'` → `'events'`, idem `end-session`,
  `queue-state`, `config`, e `src`/`href` de assets no `index.html`.
- Funciona igual sob a ponte local (servida em `/`) e sob `/embed/:t/:i/`.
- Nenhuma outra mudança de lógica.

### Overlay do embed (`public/embed-assets/overlay.js` + `overlay.css`, novo)
- Cartão do QR (`/play/totem?id=T&instance=I`) com o design system; canto inferior
  direito em quadros ≥ 4:3, rodapé centralizado em quadros estreitos; tamanho em `vmin` com `clamp()`.
- QR clicável (`<a target="_blank">`) — em celular o visitante pode jogar abrindo o link.
- Mostra vagas livres / tamanho da fila (poll em `queue-state` a cada 5s).
- `?showqr=false` esconde; `?qrpos=br|bl|bottom` posiciona.
- Lê `totemId`/`instanceId` do próprio path (`/embed/:t/:i/`); não abre SSE próprio.
- O SSE `init` passa a incluir `instanceId` (a ponte local já envia `init`; os jogos ignoram campos extras).

### Entrada do jogador (`totem-entry.js`)
- Lê `instance` da URL e envia em `join`, `status` e `queue/events`.
- Trata `410` com a mensagem "Essa tela foi fechada — abra o jogo de novo no site".
- "Jogar novamente" volta para a mesma instância.

### Dashboard (`index.html` / `dashboard.js`)
- Formulário do totem: select **Jogo** (snake / brick-rush / nenhum), `gameConfig`
  (JSON), IP/porta UDP opcionais.
- Card do totem: **Telas abertas** e **Jogadores online**.
- Botão **Incorporar** → dialog com largura/altura, responsivo (`aspect-ratio`),
  QR on/off/posição; gera o `<iframe ... allow="fullscreen">` e copia.
- Painel de fila: seletor de instância (`default` + abertas).

## 8. Design System DreamBricks

Fonte: `docs/design_system/` (tokens, componentes React, logos, mascote). O frontend
é vanilla JS, então os componentes são portados para **CSS + HTML semântico**, não React.

- `public/css/tokens.css` — cópia de `tokens/colors.css`, `typography.css`,
  `spacing.css` (fonte via `<link>` do Google Fonts no HTML, não `@import`).
- `public/css/components.css` — classes `db-*` equivalentes a Button, IconButton,
  Badge, Tag, Input, Select, Checkbox, Switch, Tabs, Card, Dialog, Toast, Tooltip,
  seguindo os `*.prompt.md`/`*.jsx` de `docs/design_system/components/`.
- `public/assets/brand/` — logos (horizontal on-light/on-blue, marca) e mascote J0Bson.
- Migrar `index.html`, `play.html`, `totem-entry.html` e o overlay: remover os
  `:root` locais, consumir só aliases semânticos (`--surface-*`, `--text-*`, `--border-*`).
- Removido o `--cta` laranja (o brandbook é só azul). Mantida a única exceção:
  paleta Xbox nos 4 botões de face do gamepad.
- `DESIGN.md` atualizado para apontar para os tokens/componentes novos.
- Execução via skill `impeccable`, respeitando `PRODUCT.md`.

## 9. Configuração (`.env`)

| Var | Default | Descrição |
|---|---|---|
| `INSTANCE_GRACE_MS` | 120000 | Folga antes de limpar instância sem SSE |
| `MAX_INSTANCES_PER_IP` | 20 | Iframes simultâneos por IP |
| `MAX_INSTANCES_PER_TOTEM` | 2000 | Iframes simultâneos por totem |
| `TRUST_PROXY` | false | Usar `X-Forwarded-For` |
| `EMBED_FRAME_ANCESTORS` | `*` | Valor do `frame-ancestors` |
| `GAMES_DIR` | `./games` | Onde ficam os jogos servidos no embed |

`nginx.conf`: adicionar `location /embed/` com buffering desligado para o SSE.

## 10. Erros e bordas

- Iframe recarrega → nova instância; a antiga expira na folga e encerra suas sessões.
- SSE cai e volta (mesmo ID) → reaproveita instância; sessões continuam.
- Celular escaneia QR de instância já fechada → 410 com mensagem clara.
- Totem sem `game` → `/embed/:id` responde 404 com página simples.
- Instância web sem nenhum SSE conectado recebe input → descartado (log debug).
- Limite atingido → SSE responde 429; overlay mostra "Muitas telas abertas, tente mais tarde".
- `end-session` por instância só afeta sessões daquela instância (ID imprevisível = escopo).

## 11. Testes

- **Unitário** `tests/unit/instances.test.mjs` (`node --test`): attach/detach/reconexão,
  limites por IP/totem, loopback sem `TRUST_PROXY`, sweep com relógio falso, `default` fora do registro.
- **E2E** (`tests/e2e/`, servidor real, como `queue.e2e.mjs`):
  1. Os 8 cenários atuais continuam passando (instância `default`).
  2. Duas instâncias do mesmo totem: filas e vagas independentes.
  3. Input do celular na instância A chega só no SSE de A.
  4. `player_join`/`player_leave` chegam no SSE certo.
  5. `end-session` via `/embed/.../end-session` libera vaga e avança a fila da instância.
  6. Instância fechada → após a folga, sessões `instance_closed`; `join` → 410.
  7. Limite por IP → 429.
  8. `/embed/:id` redireciona com ID novo a cada request; estáticos servidos; path traversal bloqueado.
- **Manual**: página de teste com 3 iframes do mesmo totem, 3 celulares, cada um controla só o seu.

## 12. Fora de escopo

- Escalar em múltiplos processos Node (registro de instâncias é em memória — 1 processo).
- Autenticação do dashboard.
- Novos jogos.
