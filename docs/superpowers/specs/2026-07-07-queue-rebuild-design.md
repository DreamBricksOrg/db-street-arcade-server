# Rebuild da Fila — 1 Sessão por Jogador

**Data**: 2026-07-07
**Status**: Aprovado
**Contexto**: O modelo atual (uma sessão compartilhada por totem, com `allowedPlayers`, backfill e auto-renew) acumulou três caminhos concorrentes de "reivindicar vaga" e gerou bugs repetidos: dois celulares com o mesmo sessionId, fila que não anda, vagas fantasmas. Este rebuild troca o modelo.

## Decisões (com o usuário)

1. **Modelo**: 1 sessão por jogador. Totem de N jogadores = até N sessões simultâneas independentes.
2. **Timeout de reivindicação**: jogador chamado da fila tem **30s** para conectar; depois vira `no_show` e a fila anda.
3. **Pós-sessão no celular**: tela "Sua sessão acabou" + botão "Jogar novamente" (volta pra entrada do totem, fim da fila).
4. **Estrutura**: novo `TotemQueueService`, único dono do ciclo fila→sessão→vaga. `SessionService` reduzido a CRUD. Elimina a dependência circular SessionService↔TotemService.

## Modelo de dados

### Sessão (Mongo `sessions` + cache Redis)
```js
{
  _id: UUID,
  totemId: UUID,
  playerId: String,            // dono único
  status: 'reserved' | 'active' | 'finished',
  totem: { id, ip, udpPort },
  metadata: { ua, ip, ... },
  createdAt: Date,
  reservedUntil: Date,         // prazo de 30s para conectar
  expiresAt: Date,             // limite de jogo (sessionDurationMs do totem)
  endedAt: Date | null,
  endReason: 'died'|'kicked'|'timeout'|'no_show'|'manual'|null
}
```
Estados: `reserved → active → finished`; `reserved → finished` (no_show/kick). Finalizadas persistem para histórico.

### Totem
- Remove `currentSessionId`.
- Ocupação = `count(sessões reserved+active do totem)`.
- `maxPlayers` (vagas simultâneas) e `maxQueueSize` (cap da fila) mantidos.

### Redis
- `queue:totem:{id}` LIST, `queue:heartbeat:{playerId}` TTL 120s, `player:metadata:{playerId}` — inalterados.
- Canal `queue:event:{totemId}` (SSE push) mantido.

## Fluxo central (serializado pelo mutex por totem)

```
join(totem, player):
  tem sessão reserved/active neste totem? → devolve (reconexão idempotente)
  ocupadas < maxPlayers e fila vazia?     → cria sessão reserved → 'play'
  fila cheia (maxQueueSize)?              → 409
  senão                                   → fila → 'queue' + posição + ETA

advance(totem):  // após endSession, no sweeper, após join
  enquanto ocupadas < maxPlayers e fila tem jogador com heartbeat vivo:
    pop → cria sessão reserved → publica SSE

endSession(sessão, motivo):
  finished → fecha WS do jogador → UDP player_leave → advance(totem)

sweeper (10s, substitui o watcher antigo):
  reserved vencida → finished('no_show') → advance
  active vencida   → finished('timeout') → advance
```

WebSocket connect (game.handler): sessão `reserved` do próprio playerId → vira `active`; `finished` → recusa (1008).

## Integração demo-snake

- Inputs UDP `{sid, pid, a, s, ts}` inalterados.
- Novo: `{type:'player_join', sid, pid, tid}` quando sessão ativa; `{type:'player_leave', sid, pid, tid}` quando encerra → jogo remove a cobra na hora.
- Removido: reset de board no `session_start`.
- Morte: jogo → `POST /end-session {pid}` (proxy demo-snake) → backend acha a sessão ativa do jogador no totem → `endSession('died')`. Mesma lógica para totem de 1 ou N jogadores.

## Rotas

| Rota | Novo comportamento |
|---|---|
| `POST /api/totems/:id/queue/join` | 'play'+sessionId próprio \| 'queue'+posição+ETA \| 409 \| 429 |
| `GET /api/totems/:id/queue/status` | 'play' se tem sessão reserved/active; senão posição+ETA |
| `GET /api/totems/:id/queue` | sessões (1/jogador: status, dispositivo, IP, sessionId) + fila + cap |
| `GET /api/totems/:id/queue/events` | SSE, mantido |
| `POST /api/totems/:id/end-session` | com playerId: encerra a dele; sem: encerra todas (reset) |
| `POST /api/sessions/:id/end` | encerra uma sessão |
| `POST /api/sessions/:id/players/:pid/kick` | vira endSession('kicked') |
| `POST /api/totems/:id/queue/clear` | limpa SÓ a lista de espera |
| `GET /api/totems/:id/session` | **removida** (legado do modelo antigo) |

Mantidos: mutex por totem, rate limit no join, ETA por média das últimas sessões, indicador de fantasma (heartbeat TTL).

## Frontend

- **totem-entry**: fluxo igual; nova tela "Sua sessão acabou" + "Jogar novamente".
- **session.js/play**: aceita `reserved`; em `session_ended` mostra a tela de fim com botão de volta pra `/play/totem?id={totemId}`.
- **dashboard**: card lista as N sessões do totem (jogador, dispositivo, IP, sessionId curto, expulsar) + fila. "Encerrar Sessão" vira "Encerrar Todas".

## Removido do código

`allowedPlayers`, backfill (`playerDied`), auto-renew (`startNewSession`), `currentSessionId`, `players[]` na sessão, watcher antigo de timeout, reset de board por `session_start`.

## Verificação

Script e2e contra servidor real: (1) 3 joins simultâneos em totem de 2 vagas → 2 sessões distintas + 1 na fila; (2) morte → fila anda <3s com sessão nova; (3) no-show 30s → pula pro próximo; (4) kick e clear; (5) reconexão idempotente devolve a mesma sessão.
