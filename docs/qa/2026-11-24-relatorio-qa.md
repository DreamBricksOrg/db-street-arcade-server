# Relatório de QA — jogos, fila, som e carga (24/11/2026)

Ambiente: backend local (Node 22) com MongoDB 7 e Redis 7 em containers isolados (portas 27117/6479), **nunca contra produção**. Commit testado: `254e1e0` + correção do item 7.

Como repetir (precisa de Mongo + Redis):

```
node tests/load/qa-queue.mjs     # 30 jogadores, single e multiplayer, cenários ruins, cues de som (~6 min)
node tests/load/qa-browser.mjs   # navegador real: cada jogo + 2 celulares (Pixel 7), som, gamepad, fim de jogo
node tests/load/qa-extra.mjs     # limite de join por IP, payloads grandes, auth do cue, SSE da fila
```

## Resumo

| Suíte | Resultado |
|---|---|
| e2e existentes (fila, n→n, auth, cluster, pontes, features) | 51/51 cenários OK |
| `qa-queue` (fila sob carga + cenários ruins + jogos) | 76/78 OK — as 2 falhas: bug nº 5 e um falso positivo (chave do totem com auth desligada; com auth ligada deu 401/200/401, ver `qa-extra`) |
| `qa-browser` (nave, snake, brick-rush com 2 celulares) | 26/26 OK depois da correção do item 7 |
| Lógica da nave (boost, pontos, onda, timer) | verificada no navegador |

**O que funcionou bem:** nunca passou de `maxPlayers` sessões vivas (1, 2 e 4 vagas; 0 violações em ~600 amostras); ordem da fila FIFO sem nenhuma inversão; a posição na fila nunca aumentou; 30/30 celulares na fila receberam o aviso por SSE quando a fila andou; 253 cues de som enviados, 0 perdidos ou entregues ao celular errado; `join` p95 ≤ 18 ms com 30 jogadores; sem erro algum nos logs do servidor; 10 joins simultâneos do mesmo jogador viram 1 sessão só; fila cheia → 409; pausa → 423; WS de intruso/sessão inexistente → fechado com 1008; flood de cue → 429.

## Cenários de carga (30 jogadores cada)

Mistura em cada rodada: 5–6 desistem no meio da fila (param de consultar), 2 são removidos pelo operador, 2–3 são chamados e não conectam (no-show), 1 conecta e some (timeout), 2 fecham a aba logo após entrar.

| Cenário | Duração | Jogaram | Sessões no_show | Fila máx. | Espera média na fila |
|---|---|---|---|---|---|
| Single-player (1 vaga), iframe | 158 s | 20 | 5 | 29 | 92 s |
| Multiplayer (4 vagas), iframe | 66 s | 19 | 9 | 26 | 16 s |
| Multiplayer (2 vagas), totem físico | 99 s | 18 | 10 | 28 | 43 s |

## Bugs

### 1. [ALTA — corrigido: heartbeat 120 s → 45 s] Quem fecha a aba na fila é chamado e trava a vaga até o no_show
Quem desiste na fila para de consultar o `queue/status`, mas o heartbeat dura 120 s (`HEARTBEAT_SECS`). Nesse tempo ele ainda é "vivo": ao chegar a vez, recebe a vaga, nunca conecta, e a vaga fica parada até `QUEUE_RESERVE_MS` (30 s em produção). No teste single-player, 5 das 25 reservas viraram no_show; com reserva de 8 s foram 40 s de vaga parada (25 % do tempo). **Com a reserva de produção (30 s), o mesmo público perderia ~150 s.** O celular consulta a fila a cada 3 s, então 120 s é folga demais.
Sugestão: heartbeat de ~15 s (renovado também pelo SSE/ping), e `navigator.sendBeacon` no `pagehide` para sair da fila (ver nº 3).

### 2. [ALTA — corrigido: padrão 8 → 60 por 10 s; ainda confirmar `TRUST_PROXY=true` em produção] Limite de entrada por IP bloqueia um evento inteiro
`QUEUE_JOIN_RATE_MAX` padrão é 8 a cada 10 s **por IP**. Com 30 pessoas no mesmo Wi-Fi/NAT (caso típico de evento), **só 8 entraram e 22 receberam 429** ("Muitas tentativas seguidas"), tendo que tocar em tentar de novo. Pior: com `TRUST_PROXY=false` atrás do nginx, o IP que conta é o do proxy — confirmado que `X-Forwarded-For` é ignorado — e o limite vira **global para todos os visitantes**. O `.env` de produção que vi antes estava em modo desenvolvimento; vale conferir `TRUST_PROXY=true` lá.
Sugestão: subir o limite (ex.: 60/10 s) ou limitar por IP + `playerId`, e `TRUST_PROXY=true` em produção (`npm run ops:check-env` ajuda).

### 3. [MÉDIA] O jogador não tem como sair da fila
Não existe endpoint para o próprio jogador sair; só o operador remove. Consequência direta do nº 1 e do nº 4.

### 4. [MÉDIA] Posição e tempo estimado incluem quem já foi embora
Quem fechou a aba continua contando na posição dos outros até chegar a sua vez ou o heartbeat expirar. Confirmado: com B ausente, C ainda vê "posição 2".

### 5. [MÉDIA — corrigido: playerId ≤ 64 e corpo do join ≤ 4 KB] `playerId` e `metadata` sem limite de tamanho
`join` aceitou `playerId` de **100 KB** e `metadata` de **500 KB** (corpo de 2 MB já dá 413). Esses valores vão para chaves do Redis e para o MongoDB. Sugestão: `maxLength: 64` no `playerId` e limite no objeto `metadata` (hoje `additionalProperties: true`, sem teto).

### 6. [BAIXA] Inputs enviados nos primeiros milissegundos após abrir o WebSocket são descartados
No teste por jogo, inputs mandados logo após o `open` não chegaram ao jogo; com 300 ms de espera chegaram (a sessão é "reclamada" de forma assíncrona). Num celular real o toque humano vem depois, então o impacto é pequeno; vale o servidor enfileirar ou o cliente esperar o claim. (Evidência por comparação de duas rodadas; não isolei a causa no código.)

### 7. [BAIXA — só Windows/dev, já corrigido na árvore] Arquivos em subpastas do jogo davam 403 no `/embed`
`path.relative` devolve `\` no Windows e o `sendFile` recusa. O logo do snake (`assets/dreambricks-mark-blue.svg`) ficava quebrado no iframe. Corrigido em `src/modules/embed/embed.routes.js` (`.split(path.sep).join('/')`); verificado: 403 → 200. Em Linux/Docker não acontece.

### 8. [BAIXA] Nave: "Última pontuação" fica em cima da área de jogo
O texto no topo central se sobrepõe a blocos e naves que passam por ali (visível nos screenshots que o `qa-browser` grava em `QA_SHOTS`). Sugestão: mover o placar para uma faixa fixa ou diminuir a opacidade.

### 9. [BAIXA] "Melhor pontuação" da nave só atualiza o ranking ao abrir a tela
O melhor do dia é lido do `/ranking` uma vez no carregamento e sobe localmente; recordes de outras telas só aparecem ao recarregar.

### 10. Limitações conhecidas (não são bugs novos)
- Snake e brick-rush no **totem físico** não têm efeitos de som: as pontes UDP não repassam `/cue`. Música e "fim de jogo" funcionam.
- O som só começa depois de **um toque** (política dos navegadores); a tela "Toque para ligar o som do jogo" aparece quando o navegador não libera sozinho. Confirmado em Chromium.
- Teste de UI do painel falha de vez em quando com `login → 429` (10 logins/min por IP em muitos testes seguidos); a reexecução passa.
- `POST /embed/.../cue` é público (limite 60/s por IP) e aceita `pid`; os `pid` de 8 caracteres aparecem no `queue-state` público. O pior caso é tocar efeitos sonoros no celular de outro jogador da **mesma instância**; sem dados sensíveis.

## Não coberto
Som audível em celular real (o teste confere o agendamento de notas/efeitos e o estado do `AudioContext`, não o áudio); iOS/Safari; carga acima de 30 jogadores ou vários processos do backend em paralelo; as pontes UDP do totem físico com Unity.
