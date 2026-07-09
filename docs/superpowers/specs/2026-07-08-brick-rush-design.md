# Brick Rush — Platformer Lego para Street Arcade

**Data**: 2026-07-08
**Status**: Aprovado
**Referência de integração**: `docs/game-integration.md` (padrão demo-snake)

## Conceito

Corrida de plataforma estilo Transformice em estética Lego. Minifigs coloridos
(uma cor por jogador) disputam quem alcança primeiro o **brick 2x4** no alto do
mapa, escalando paredes e usando plataformas móveis. Partidas de 3 rounds em
mapas gerados por **Wave Function Collapse**, cada round num tema diferente.

## Decisões (com o usuário)

1. **Fim de round**: quando o 1º pega o brick, abre janela de graça de 10s para
   os demais chegarem. Timer máximo do round: 90s. Pontos por ordem de chegada:
   1º=5, 2º=3, 3º=2, demais=0.
2. **Morte in-game** (lava/vazio/hazard): minifig se despedaça (peças lego se
   separam), respawn no spawn após 3s. NÃO encerra a sessão — morte é perda de
   tempo, não eliminação.
3. **Início da partida**: vagas cheias → countdown 3s. Não encheu → começa 30s
   após o 1º conectar, com quem estiver (mínimo 1).
4. **Rotação pós-partida**: K = min(tamanho da fila, jogadores−1). Os K últimos
   colocados são eliminados via `POST /end-session {pid}`; o 1º colocado NUNCA
   sai (win-streak). Novos jogadores entram pela fila do backend.
5. **Colocação final**: soma dos pontos dos 3 rounds. Desempate: menor tempo
   somado de captura do brick; persistindo, quem entrou primeiro na partida.
6. **Controles**: D-pad esquerda/direita move; D-pad baixo desce de plataforma
   one-way; **A** pula (segurando na parede: wall-jump — é assim que se escala);
   **B** dash horizontal curto (cooldown 3s).
7. **Engine**: Canvas 2D vanilla, zero dependências, padrão demo-snake
   (server.js ponte + jogo browser). Portas: HTTP 9100, UDP 9101.

## Estrutura

```
games/brick-rush/
├── server.js          # ponte UDP:9101→SSE + proxies (end-session, queue-state) + static :9100
├── .env               # BACKEND_URL, TOTEM_ID
├── test/wfc.test.mjs  # 200 gerações/tema → 100% alcançável ou fallback
└── public/
    ├── index.html     # TV: canvas fullscreen + HUD
    ├── main.js        # boot, game loop, SSE wiring, roteamento de pacotes
    ├── match.js       # máquina de estados da partida + rotação
    ├── physics.js     # AABB, gravidade, pulo, wall-jump, dash, plat. móveis, gimmicks
    ├── wfc.js         # WFC genérico + validação de alcançabilidade (BFS de saltos)
    ├── maps.js        # 6 temas: tilesets, adjacências, pesos, gimmick, fallback handcrafted
    ├── entities.js    # minifig, brick 2x4, partículas de morte
    └── render.js      # tiles com studs, minifigs, HUD, telas de lobby/placar
```

## Máquina de estados (match.js)

```
LOBBY      jogadores entram (player_join). Vagas cheias → COUNTDOWN.
           Senão: 30s após o 1º → COUNTDOWN. HUD mostra "aguardando X/N".
COUNTDOWN  3s → ROUND_PLAY (round 1).
ROUND_PLAY WFC gera mapa (tema sorteado, sem repetir na partida).
           Corrida. 1º pega o brick → GRACE (10s). Timer 90s → ROUND_END direto.
GRACE      demais podem chegar; acabou 10s ou todos chegaram → ROUND_END.
ROUND_END  placar do round 5s na tela → próximo round ou MATCH_END (após 3º).
MATCH_END  pódio 8s. Calcula colocação final.
ROTATION   lê fila via proxy /queue-state → K = min(fila, jogadores−1)
           → POST /end-session {pid} para os K últimos → LOBBY.
```

Eventos assíncronos em qualquer estado:
- `player_leave` (kick do operador / timeout de sessão): remove o minifig na
  hora; nos rounds restantes ele pontua 0. Se a partida ficar com 0 jogadores,
  volta ao LOBBY.
- `player_join` durante partida em andamento: entra como espectador no HUD
  ("aguardando próxima partida") e joga a partir do próximo LOBBY.

## Integração Street Arcade

- Jogadores indexados pelo **pid truncado (8 chars)** dos pacotes UDP.
- Cores: paleta fixa de 8 cores atribuídas na ordem de entrada.
- Inputs: `{pid, a, s}` → estado de teclas por jogador (pressed/released).
- Eliminação pós-partida: `POST {local}/end-session {pid}` (proxy → backend
  `POST /api/totems/:id/end-session {playerId}`) — backend derruba o celular
  (tela "Jogar novamente") e a fila avança sozinha.
- Fila: `GET {local}/queue-state` (proxy → `GET /api/totems/:id/queue`) para
  saber K na rotação e exibir tamanho da fila no HUD.
- Proxies existem porque o backend não expõe CORS; o server local repassa.

## WFC + validação de alcançabilidade (wfc.js)

- Grid 40×22 tiles (tile = 32px → canvas 1280×704).
- Tiles: `vazio`, `bloco`, `plataforma`, `one-way`, `hazard`, `trilho`
  (plataforma móvel), `spawn-zone` (faixa inferior), `brick-zone` (faixa
  superior). Adjacências e pesos definidos POR TEMA em maps.js.
- Algoritmo: entropia mínima → colapsa → propaga restrições; contradição →
  restart. Bordas forçadas: chão sólido embaixo, paredes laterais.
- Pós-processamento: posiciona spawns (1 por jogador, espaçados) na base e o
  brick numa célula da brick-zone; instancia plataformas móveis nos trilhos.
- **Validação**: BFS do spawn ao brick usando o envelope de movimento real
  (pulo: alcance dx≤4/dy≤3 tiles; wall-jump em paredes verticais; plataformas
  móveis contam como ponte no seu trajeto; hazards não bloqueiam, só matam).
  Falhou → re-gera (máx. 20 tentativas) → fallback: mapa handcrafted do tema.
  O arcade NUNCA trava por mapa impossível.

## Os 6 temas (maps.js)

| Tema | Singularidade física |
|---|---|
| ❄️ Gelo | Atrito baixo — derrapa ao parar/virar |
| 🔥 Vulcão | Lava sobe do fundo lentamente durante o round (hazard dinâmico) |
| 🌲 Floresta | Cogumelos-trampolim: pulo 2× ao quicar |
| 🤖 Tecnológico | Esteiras rolantes empurram + plataformas móveis 1.5× mais rápidas |
| 🏜️ Deserto | Areia movediça (afunda parado) + rajadas de vento horizontais |
| 🔮 Cristal | Gravidade 0.6× — pulos flutuantes, quedas lentas |

Cada partida sorteia 3 temas distintos. Cada tema tem 1 mapa fallback
handcrafted comprovadamente jogável.

## Física (physics.js)

- AABB vs grid de tiles; gravidade 9.8*escala; velocidade terminal.
- Corrida: aceleração/atrito no chão (modificado por gelo/areia).
- Pulo com coyote-time (100ms) e jump-buffer (100ms) — essencial em arcade.
- Wall-slide (desliza devagar encostado na parede caindo) + wall-jump
  (impulso diagonal oposto) — o "escalar" do jogo.
- Dash (B): impulso horizontal 3 tiles, 150ms, cooldown 3s, não atravessa bloco.
- Plataformas móveis: carregam o jogador (delta aplicado), trajeto vai-e-volta
  no trilho.

## Fora de escopo (v1)

- Som, skins além de cor, poderes/itens, espectador remoto, ranking persistente
  entre partidas (win-streak vive só em memória do jogo).

## Verificação

1. `node games/brick-rush/test/wfc.test.mjs` — 200 mapas × 6 temas: todo mapa
   entregue é alcançável (gerado válido ou fallback).
2. Fluxo manual com 3 celulares + 2 na fila: partida completa, rotação expulsa
   os 2 últimos, vencedor permanece, os 2 da fila entram.
3. Backend intocado — `npm run test:e2e` continua verde (nada muda no backend).
