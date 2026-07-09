# 🐍 Snake

Snake multiplayer integrado à fila do Street Arcade. Cada celular controla uma
cobra colorida; morrer encerra a sessão do jogador e o próximo da fila entra
automaticamente. Aplicação isolada — poderia ser Unity, Python, C++ etc.
(padrão de integração: `docs/game-integration.md`).

## Como rodar

1. **Backend** rodando na raiz do repo: `npm run dev`
2. **Cadastrar o totem** no dashboard (`http://localhost:3000`):
   IP da máquina do jogo, **porta UDP 9001**, máx. jogadores 1–8.
3. Copiar o `_id` do totem para `games/snake/.env` (`TOTEM_ID=...`)
   — opcional: o jogo também aprende o ID no primeiro `player_join`.

   Configurações do jogo no mesmo `.env` (lidas via `GET /config`):
   ```env
   SNAKE_SPEED=5       # movimentos da cobra por segundo
   POINTS_PER_FOOD=10  # pontos por comida
   BOOST_MOVES=3       # movimentos por frame segurando B (boost)
   ```
4. Subir o jogo:
   ```bash
   node games/snake/server.js
   ```
5. Abrir na TV do totem: **http://localhost:9000**
6. Jogadores escaneiam o QR permanente do totem e entram pela fila normal.

## Como jogar

- **D-Pad**: direção da cobra
- **B** (segurar): boost de velocidade (com glow)
- Comer a comida cresce a cobra e pontua
- Bater na parede, em outra cobra ou em si mesmo = morte → sua sessão encerra,
  o celular mostra "Jogar novamente" e o próximo da fila assume a vaga

## Portas / endpoints do server ponte

| O quê | Valor |
|---|---|
| HTTP (TV + endpoints) | 9000 |
| UDP (pacotes do backend) | 9001 |
| `GET /events` | SSE — repassa os pacotes UDP pro browser |
| `GET /config` | Config do jogo (do `.env`) |
| `GET /queue-state` | Proxy da fila do totem |
| `POST /end-session` | Proxy de morte (`{ pid }`) pro backend |
