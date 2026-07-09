# 🧱 Brick Rush

Platformer multiplayer estilo Transformice em versão Lego, integrado à fila do
Street Arcade. Minifigs coloridos (uma cor por jogador) correm para alcançar o
**brick 2x4 dourado** escalando paredes (wall-jump) e pegando plataformas
móveis. Mapas gerados por **Wave Function Collapse** com validação de
alcançabilidade — nenhum round nasce impossível.

## Regras

- **Partida = N rounds** (configurável, padrão 3), cada um num tema sorteado
  (de 6) com física própria:
  ❄️ Gelo (blocos de gelo escorregadios) · 🔥 Vulcão (lava sobe — única morte
  ambiental do jogo) · 🌲 Floresta (trampolins) · 🤖 Laboratório (esteiras +
  plataformas rápidas) · 🏜️ Deserto (dunas de areia lisa) · 🔮 Cristal
  (gravidade baixa)
- **Round**: o 1º a tocar o brick abre uma janela de graça para os demais.
  Pontos por chegada: 1º=5, 2º=3, 3º=2. Timer máximo configurável (padrão 90s).
- **Morrer no round** (só na lava do Vulcão): o minifig se despedaça e renasce
  em 3s num ponto **seguro acima da lava** — perde tempo, não é eliminado.
- **Início**: vagas cheias → countdown 3s; senão começa 30s após o 1º conectar.
  Quem conectar durante o countdown ainda entra na partida.
- **Fim da partida**: **TODOS** os jogadores são desconectados, inclusive o
  campeão (celular mostra "Jogar novamente" → fim da fila). Para jogar de novo
  é preciso reconectar. O campeão fica registrado no HUD do lobby.

## Controles (gamepad do celular)

| Botão | Ação |
|---|---|
| D-pad ◀ ▶ | Correr |
| D-pad ▼ | Descer de plataforma vazada |
| **A** | Pular / wall-jump (encostado na parede = escalar) |
| **B** | Dash (cooldown 3s — barra branca nos pés indica pronto) |

## Como rodar

1. **Backend** rodando na raiz do repo: `npm run dev`
2. **Cadastrar o totem** no dashboard (`http://localhost:3000`):
   IP da máquina do jogo, **porta UDP 9101**, máx. jogadores 2–4.
3. Copiar o `_id` do totem para `games/brick-rush/.env` (`TOTEM_ID=...`)
   — opcional: o jogo também aprende o ID no primeiro `player_join`.

   Configurações do jogo no mesmo `.env` (lidas via `GET /config`):
   ```env
   GAME_ROUNDS=3      # rounds por partida
   ROUND_TIME_S=90    # tempo máximo por round (segundos)
   GRACE_TIME_S=10    # janela de graça após o 1º pegar o brick
   LOBBY_WAIT_S=30    # espera no lobby após o 1º jogador conectar
   ```
4. Subir o jogo:
   ```bash
   node games/brick-rush/server.js
   ```
5. Abrir na TV do totem: **http://localhost:9100**
6. Jogadores escaneiam o QR permanente do totem e entram pela fila normal.

## Testes

```bash
node games/brick-rush/test/wfc.test.mjs      # 1200 mapas — 100% alcançáveis
node games/brick-rush/test/physics.test.mjs  # envelope real ≥ envelope do validador
node games/brick-rush/test/match.test.mjs    # partida completa headless + rotação
```

## Arquitetura

Padrão do `docs/game-integration.md` (igual ao demo-snake): `server.js` é uma
ponte UDP:9101→SSE com proxies HTTP (`/end-session`, `/queue-state`) e o jogo
roda 100% no browser (Canvas 2D, zero dependências).

```
public/
├── main.js      # boot, SSE, loop
├── match.js     # máquina de estados: lobby → 3 rounds → pódio → rotação
├── physics.js   # AABB, pulo/wall-jump/dash, plataformas móveis, gimmicks
├── wfc.js       # WFC + reparo guiado + BFS de alcançabilidade
├── maps.js      # 6 temas (pesos, regras de adjacência, fallback handcrafted)
├── entities.js  # paleta, partículas de morte, brick
└── render.js    # tiles lego com studs, minifigs, HUD, telas
```
