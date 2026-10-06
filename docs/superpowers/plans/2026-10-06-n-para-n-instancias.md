# Street Arcade n→n + Design System DreamBricks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cada iframe de um totem incorporado num site vira uma instância isolada (fila, sessões, QR e celulares próprios), coexistindo com o totem físico (instância `default`, UDP); e todas as telas passam a usar o Design System DreamBricks.

**Architecture:** Registro de instâncias em memória (`src/lib/instances.js`); fila/mutex/sessões chaveados por `totemId:instanceId`; um único `GameOutput` decide UDP (default) ou SSE (`InstanceHub`) para cada pacote; rotas `/embed/:totemId/:instanceId/*` servem o jogo de `games/<game>/public` e implementam o mesmo contrato da ponte local (`events`, `end-session`, `queue-state`, `config`).

**Tech Stack:** Node 20 ESM, Fastify 5, MongoDB, ioredis, `node:test`, vanilla JS/CSS no frontend.

Spec: `docs/superpowers/specs/2026-10-06-n-para-n-instancias-design.md`

---

## File map

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `src/lib/instances.js` | criar | Registro puro de instâncias (attach/detach/limites/sweep) |
| `tests/unit/instances.test.mjs` | criar | Testes unitários do registro (relógio falso) |
| `src/lib/channels.js` | alterar | `DEFAULT_INSTANCE`, `normalizeInstance`, `instanceKey`, `queueKey`, `queueEventChannel` |
| `src/config/env.js` | alterar | `INSTANCE_GRACE_MS`, `MAX_INSTANCES_PER_IP/TOTEM`, `TRUST_PROXY`, `EMBED_FRAME_ANCESTORS`, `GAMES_DIR` |
| `src/plugins/mongodb.js` | alterar | índice `{totemId, instanceId, status}` |
| `src/modules/session/session.repository.js` | alterar | `instanceId` em create e filtros |
| `src/modules/session/session.cache.js` | alterar | campo `instanceId` |
| `src/modules/instance/instance.hub.js` | criar | Conexões SSE por instância, `push()` |
| `src/modules/game/game.output.js` | criar | `send(session, packet)` → UDP ou hub |
| `src/modules/udp/udp.dispatcher.js` | alterar | resolve sessão e delega envio ao `GameOutput` |
| `src/modules/game/game.handler.js` | alterar | `player_join` via `GameOutput` |
| `src/modules/totem/totemQueue.service.js` | alterar | tudo por `(totemId, instanceId)`; `endAllForInstance`; `isLive` → 410 |
| `src/modules/totem/totem.service.js` / `totem.repository.js` | alterar | `game`, `gameConfig`, `ip`/`udpPort` opcionais |
| `src/modules/totem/totem.routes.js` | alterar | `?instance=`, `GET /:id/instances`, SSE por chave de instância, sweeper de instâncias |
| `src/modules/embed/embed.routes.js` | criar | `/embed/*` + `/embed-assets/*` |
| `src/app.js` | alterar | registry/hub/gameOutput decorados; registra embed routes |
| `games/snake/public/*`, `games/brick-rush/public/*` | alterar | URLs relativas |
| `public/totem-entry.js`, `public/session.js` | alterar | `instance` na URL / replay |
| `tests/e2e/instances.e2e.mjs` | criar | cenários n→n |
| `public/css/tokens.css`, `public/css/components.css`, `public/assets/brand/*` | criar | Design system |
| `public/embed/overlay.js`, `public/embed/overlay.css` | criar | QR sobre o jogo |
| `public/index.html`, `dashboard.js`, `play.html`, `totem-entry.html` | alterar | DS + jogo/embed no dashboard |
| `CLAUDE.md`, `DESIGN.md`, `nginx.conf`, `docs/game-integration.md` | alterar | documentação |

---

### Task 1: Registro de instâncias (TDD)

**Files:** Create `src/lib/instances.js`, `tests/unit/instances.test.mjs`; Modify `package.json` (script `test:unit`).

API:
```js
createInstanceRegistry({ now = Date.now, graceMs = 120000, maxPerIp = 20, maxPerTotem = 2000 })
  .validId(id) → boolean                       // /^[A-Za-z0-9_-]{1,64}$/, e != 'default'
  .attach(totemId, instanceId, conn, ip) → {ok:true, inst} | {ok:false, code:400|429, error}
  .detach(totemId, instanceId, conn)          // ignora conn que não está registrada
  .get(totemId, instanceId) → inst | null     // inst = { totemId, id, conns:Set, ip, createdAt, lastSeenAt }
  .isLive(totemId, instanceId) → boolean      // online, ou offline há <= graceMs
  .list(totemId) → [{ id, online, createdAt, lastSeenAt }]
  .sweep() → [{ totemId, id }]                // remove offline > graceMs
  .totals() → { instances, online }
```
IP `null` ou loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) não conta no limite por IP.

- [ ] Step 1: escrever `tests/unit/instances.test.mjs` cobrindo: id inválido → 400; attach novo; reconexão do mesmo id não conta limite; limite por IP → 429; loopback ignora limite por IP; limite por totem → 429; detach de conn antiga não derruba; `isLive` dentro/fora da folga; `sweep` remove só offline expiradas; `list`/`totals`.
- [ ] Step 2: `node --test tests/unit/` → FAIL (módulo inexistente).
- [ ] Step 3: implementar `src/lib/instances.js`.
- [ ] Step 4: `node --test tests/unit/` → PASS. Adicionar `"test:unit": "node --test tests/unit/"` no `package.json`.
- [ ] Step 5: commit `feat(instances): add in-memory instance registry`.

### Task 2: Config + helpers de chave

**Files:** Modify `src/config/env.js`, `src/lib/channels.js`.

```js
// channels.js
export const DEFAULT_INSTANCE = 'default'
export const normalizeInstance = (id) => (id && id !== DEFAULT_INSTANCE ? String(id) : DEFAULT_INSTANCE)
export const isDefaultInstance = (id) => normalizeInstance(id) === DEFAULT_INSTANCE
export const instanceKey = (totemId, instanceId) =>
  isDefaultInstance(instanceId) ? totemId : `${totemId}:${instanceId}`
export const queueKey = (totemId, instanceId) => `queue:totem:${instanceKey(totemId, instanceId)}`
export const queueEventChannel = (totemId, instanceId) => `queue:event:${instanceKey(totemId, instanceId)}`
```
env: `instanceGraceMs`, `maxInstancesPerIp`, `maxInstancesPerTotem`, `trustProxy` (`'true'|'1'`), `embedFrameAncestors` (default `*`), `gamesDir` (default `<repo>/games`).

- [ ] Implementar; `node -e "import('./src/lib/channels.js').then(m=>console.log(m.queueKey('t','default'), m.queueKey('t','a1')))"` → `queue:totem:t queue:totem:t:a1`.
- [ ] Commit `feat: instance-aware key helpers and env`.

### Task 3: Sessão com `instanceId`

**Files:** Modify `session.repository.js`, `session.cache.js`, `src/plugins/mongodb.js`.

- `create({ ..., instanceId })` grava `instanceId: normalizeInstance(instanceId)`.
- Helper `instFilter(instanceId)` → default: `{ instanceId: { $in: ['default', null] } }`; web: `{ instanceId }`.
- `findCurrentByPlayer(totemId, instanceId, playerId)`, `listCurrentByInstance(totemId, instanceId)`, `countCurrent(totemId, instanceId)`, `findRecentFinished(totemId, limit)` (inalterado — ETA usa histórico do totem). `listCurrentByTotem(totemId)` continua (todas as instâncias).
- Cache: `instanceId` no HASH e no `get`.
- Índice `sessions_totem_instance_status`.
- [ ] Implementar; commit `feat(session): track instanceId`.

### Task 4: InstanceHub + GameOutput

**Files:** Create `src/modules/instance/instance.hub.js`, `src/modules/game/game.output.js`; Modify `udp.dispatcher.js`, `game.handler.js`, `src/app.js`.

```js
// instance.hub.js
export class InstanceHub {
  add(totemId, instanceId, res)      // res = raw ServerResponse
  remove(totemId, instanceId, res)
  push(totemId, instanceId, packet)  // → number de conexões que receberam
  count(totemId, instanceId)
  closeInstance(totemId, instanceId) // encerra as respostas SSE
}
// game.output.js
export class GameOutput {
  constructor({ udpSend, hub })
  send(session, packet)  // packet objeto; default → JSON.stringify p/ cada session.totems (pula sem ip); web → hub.push
}
```
- Dispatcher: `_resolveSession(sessionId)` (memória → cache → Mongo) devolve `{ totemId, instanceId, totems }`; envia `gameOutput.send(...)` com o pacote atual (objeto).
- `game.handler.onConnect`: `fastify.gameOutput.send(session, { type:'player_join', sid, pid, tid })`; `registerSession(sessionId, session)`.
- `app.js`: logo após o UDP plugin, criar `registry`, `hub`, `gameOutput` e decorar `instances`, `instanceHub`, `gameOutput`.
- [ ] Implementar; `npm run test:e2e` (8 cenários atuais) → PASS; commit `feat: route game packets via GameOutput (UDP or SSE)`.

### Task 5: Fila por instância

**Files:** Modify `totemQueue.service.js`, `session.routes.js` (só se usar assinaturas alteradas).

- Assinaturas: `join(totemId, instanceId, playerId, metadata)`, `status(totemId, instanceId, playerId)`, `kickFromQueue(totemId, instanceId, playerId)`, `clearQueue(totemId, instanceId)`, `operatorView(totemId, instanceId)`, `findCurrentByPidPrefix(totemId, instanceId, pid)`, `endAllForTotem(totemId, reason)` (todas as instâncias), `endAllForInstance(totemId, instanceId, reason)`, `_advanceLocked(totem, instanceId)`.
- Lock key: `instanceKey(totemId, instanceId)`; `endSession` usa `instanceKey(session.totemId, session.instanceId)`.
- `_checkInstance(instanceId)`: se não-default e `!fastify.instances.isLive(totemId, id)` → `{ ok:false, code:410, error:'Instance closed' }` (em `join` e `status`).
- `_createReserved(totem, instanceId, ...)`: `totems: totem.ip ? [{...}] : []`.
- `_sendPlayerLeave` → `fastify.gameOutput.send(session, {...})`.
- `_publishQueueEvent(totemId, instanceId)` → `queueEventChannel`.
- `dropInstance(totemId, instanceId)`: `endAllForInstance(..., 'instance_closed')` + `del` da fila.
- [ ] Implementar; commit `feat(queue): per-instance queue and sessions`.

### Task 6: Totem com jogo

**Files:** Modify `totem.service.js`, `totem.repository.js`; Create `src/lib/games.js`.

```js
// src/lib/games.js
export function listGames(gamesDir)        // dirs com public/index.html
export function isKnownGame(gamesDir, name)
export function gamePublicDir(gamesDir, name)
```
- create: `ip` opcional; se `ip` → `udpPort` 1–65535 obrigatório; `game` válido ou null; ao menos `ip` ou `game`; `gameConfig` objeto ou null.
- update: idem para os campos presentes (`ip: ''`/null limpa ip+udpPort).
- [ ] Implementar; commit `feat(totem): game + gameConfig, UDP optional`.

### Task 7: Rotas de totem por instância

**Files:** Modify `totem.routes.js`.

- Querystring `instance` (pattern `^[A-Za-z0-9_-]{1,64}$`) em join/status/events/kick/clear/queue/end-session.
- Schemas: `ip` nullable, `udpPort` nullable, `game`, `gameConfig` (object additionalProperties), `instances: {open, online}`, `playersOnline`; POST `required: ['name']`.
- 410 nos responses de join/status.
- SSE da fila: mapa por `instanceKey`, psubscribe `queue:event:*` (o sufixo do canal já é a chave).
- `GET /api/totems/:id/instances` → `[{ id:'default', online:null, sessions, queueSize }, ...registry.list]` com contagens.
- `GET /api/games` → `listGames`.
- `DELETE /api/totems/:id` → `endAllForTotem` + limpa fila default + `dropInstance` de cada instância listada + `hub.closeInstance`.
- Sweeper: além de `queue.sweep()`, `for (const i of instances.sweep()) queue.dropInstance(i.totemId, i.id)`.
- [ ] Implementar; `npm run test:e2e` → PASS; commit.

### Task 8: Rotas de embed

**Files:** Create `src/modules/embed/embed.routes.js`; Modify `src/app.js`.

- `GET /embed/:totemId` → 404 se totem sem `game`; 302 para `/embed/:totemId/<uuid>/` + query original.
- `GET /embed/:totemId/:instanceId` (sem barra) → 301 com barra (URLs relativas dependem disso).
- `GET /embed/:totemId/:instanceId/` → lê `index.html` do jogo, injeta antes de `</body>`:
  `<link rel="stylesheet" href="/embed-assets/overlay.css"><script src="/embed-assets/overlay.js" defer></script>`.
- `GET .../events` → valida id; `instances.attach(totemId, id, res, clientIp)`; 429/400 JSON se falhar; hijack, headers SSE, `connected` + `init {totemId, instanceId}`; `hub.add`; ping 15s; on close: `hub.remove` + `instances.detach`.
- `POST .../end-session` `{pid}` → `findCurrentByPidPrefix(totemId, id, pid)` → `endSession(_, 'died')`.
- `GET .../queue-state` → `operatorView(totemId, id)` sem `ok`.
- `GET .../config` → `totem.gameConfig ?? {}`.
- `GET .../*` → `reply.sendFile(rel, gamePublicDir)` com `path.normalize` e bloqueio de `..` (`@fastify/static` decorou `sendFile` com root custom: `reply.sendFile(file, rootDir)`).
- `GET /embed-assets/*` → `public/embed/`.
- Hook `onSend` para `/embed/`: `Content-Security-Policy: frame-ancestors ${env.embedFrameAncestors}`.
- Client IP: `env.trustProxy ? x-forwarded-for[0] : request.socket.remoteAddress`.
- [ ] Implementar; commit.

### Task 9: Jogos com URLs relativas

**Files:** `games/snake/public/game.js:104,196,300`, `games/brick-rush/public/main.js:14,20,53`, `games/brick-rush/public/match.js:302`, `games/brick-rush/public/index.html:44`.
- `'/events'`→`'events'`, `'/config'`→`'config'`, `'/end-session'`→`'end-session'`, `'/queue-state'`→`'queue-state'`, `src="/main.js"`→`src="main.js"`.
- [ ] Editar; `node --test games/brick-rush/test/` → PASS; commit.

### Task 10: E2E n→n

**Files:** Create `tests/e2e/instances.e2e.mjs`; `package.json` `test:e2e` roda os dois arquivos.

Cenários (servidor real em porta 3101, `INSTANCE_GRACE_MS=1500`, `QUEUE_SWEEP_MS=500`, `MAX_INSTANCES_PER_IP=3`, `TRUST_PROXY=true` para simular IPs via header):
1. `/embed/:id` → 302 com ids diferentes em 2 requests; totem sem game → 404.
2. Página da instância contém `overlay.js`; `.../game.js` 200; `.../..%2f..%2fpackage.json` → 404.
3. SSE de A e B abertos; join em A e B (maxPlayers 1) → ambos `play` (vagas independentes); 2º jogador em A → `queue`.
4. WS do jogador de A → SSE de A recebe `player_join`; input `btn_A pressed` chega em A e não em B.
5. `POST /embed/T/A/end-session {pid}` → sessão finished `died`; fila de A avança.
6. Fecha SSE de B → após folga, sessão de B `instance_closed`; `join` em B → 410.
7. 4º SSE do mesmo `X-Forwarded-For` → 429.
- [ ] Escrever, rodar até passar; commit.

### Task 11: Clientes do jogador

**Files:** `public/totem-entry.js`, `public/session.js`, `session.routes.js` (schema devolve `instanceId`).
- totem-entry: `instance = params.get('instance')`; `qs = instance ? '&instance='+instance : ''` em join (`?instance=`), status, events; storage key inclui instância; 410 → "Essa tela foi fechada. Abra o jogo de novo no site."
- session.js: replay → `/play/totem?id=${totemId}${instanceId && instanceId!=='default' ? '&instance='+instanceId : ''}`.
- [ ] Implementar; commit.

### Task 12: Design system — fundação

**Files:** Create `public/css/tokens.css` (concat de `docs/design_system/tokens/colors.css`, `typography.css`, `spacing.css`), `public/css/components.css`, `public/assets/brand/` (logos horizontal on-light/on-blue, mark-blue/white, mascote standing).
- `components.css`: `.db-btn` (+`--primary|--secondary|--ghost|--danger`, `--sm|--lg`), `.db-icon-btn`, `.db-badge` (+`--success|--warning|--danger|--info|--neutral`), `.db-tag`, `.db-input`, `.db-select`, `.db-field`/`.db-label`/`.db-hint`, `.db-switch`, `.db-checkbox`, `.db-tabs`/`.db-tab[aria-selected]`, `.db-card` (+`--capsule` com um canto pill), `.db-dialog` (`<dialog>`), `.db-toast`, `.db-tooltip`, `.db-mono`, `.db-eyebrow`; seguindo os `.jsx`/`.prompt.md` de `docs/design_system/components/`.
- [ ] Criar; commit `feat(ui): DreamBricks design system foundation`.

### Task 13: Overlay do embed

**Files:** Create `public/embed/overlay.js`, `public/embed/overlay.css`.
- Lê `/embed/:t/:i/` do path; query `showqr`, `qrpos`.
- Busca `/api/totems/:t/qr`? Não — gera via novo endpoint `GET /api/totems/:id/qr?format=dataurl&instance=I` (Task 7 adiciona `instance` à URL do QR).
- Cartão: logo mark, "Escaneie para jogar", QR (`<a target=_blank>`), linha de status "N vagas livres · fila M" (poll `queue-state` 5s); 429 do SSE não é visível ao overlay → overlay faz `fetch('events')`? Não: mostra estado só via queue-state; ok.
- Estilo isolado com prefixo `.dbx-` e tokens locais (o jogo não carrega `tokens.css`).
- [ ] Criar; commit.

### Task 14: Migrar telas para o DS + embed no dashboard

**Files:** `public/index.html`, `public/dashboard.js`, `public/play.html`, `public/totem-entry.html`.
- Trocar `:root` locais por `<link href="/css/tokens.css">` + `/css/components.css`; aliases semânticos; logo DreamBricks no header; remover `--cta` laranja; manter paleta Xbox em `#gamepad`.
- Dashboard: form com select Jogo (de `/api/games`), `gameConfig` JSON, IP/porta opcionais; card com "Telas abertas"/"Jogadores"; botão Incorporar → `<dialog class="db-dialog">` com largura/altura/responsivo/QR/posição, preview do código e copiar; painel de fila com seletor de instância.
- Usar skill `impeccable` para polish/audit ao final.
- [ ] Implementar; verificar no navegador; commit.

### Task 15: Docs

- `CLAUDE.md`: conceitos totem/instância, novas rotas, env, Redis keys, fluxo embed.
- `DESIGN.md`: aponta para `public/css/tokens.css`/`components.css`; remove `cta-orange`.
- `docs/game-integration.md`: jogos devem usar URLs relativas; embed.
- `nginx.conf`: `location /embed/` com `proxy_buffering off` e timeouts longos.
- [ ] Commit `docs: n-to-n instances + design system`.
