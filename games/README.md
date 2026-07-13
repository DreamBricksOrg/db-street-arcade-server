# 🎮 Jogos do Street Arcade

Cada jogo é uma aplicação isolada que segue o padrão de integração descrito em
[`docs/game-integration.md`](../docs/game-integration.md): um `server.js` ponte
(UDP → SSE + proxies HTTP) e o jogo rodando no browser da TV do totem.

| Jogo | Pasta | HTTP | UDP | Descrição |
|---|---|---|---|---|
| 🐍 Snake | [`snake/`](snake/) | 9000 | 9001 | Cobras multiplayer; morrer = sessão encerra e a fila anda |
| 🧱 Brick Rush | [`brick-rush/`](brick-rush/) | 9100 | 9101 | Platformer estilo Transformice; partidas de N rounds em mapas WFC |

## Convenções (todo jogo segue)

- **`.env`** com `BACKEND_URL`, `TOTEM_ID` e as configurações do jogo
- **`GET /config`** — expõe as configurações do `.env` pro browser
- **`GET /events`** — SSE que repassa os pacotes UDP do backend
- **`GET /queue-state`** — proxy da fila do totem (HUD/rotação)
- **`POST /end-session`** — proxy `{ pid }` → encerra a sessão do jogador no backend
- Jogadores indexados pelo **pid truncado de 8 chars** dos pacotes UDP
- `player_leave` remove o avatar na hora; sem reset de board quando alguém entra/sai

## Criando um jogo novo

1. Copie a pasta `snake/` (a ponte mais simples) ou `brick-rush/` (com partidas/rounds)
2. Troque as portas (HTTP e UDP) para valores livres
3. Cadastre um totem no dashboard apontando pra porta UDP escolhida
4. Siga o checklist do [`docs/game-integration.md`](../docs/game-integration.md)

## Rodando com Docker

Cada jogo tem seu próprio `Dockerfile` + `docker-compose.yml` (independentes
entre si e do compose do dashboard na raiz do repo):

```bash
cd games/snake && docker compose up -d --build
cd games/brick-rush && docker compose up -d --build
```

Cada compose publica a porta HTTP (TV) e a porta UDP (backend → jogo), e
sobrescreve `BACKEND_URL` do `.env` pra `http://host.docker.internal:3000` —
assim funciona out-of-the-box com o dashboard rodando no mesmo host (nativo
ou via `docker compose` na raiz). Se o dashboard estiver em outra máquina,
ajuste esse valor no `docker-compose.yml` do jogo. Depois de subir, cadastre
o totem no dashboard com o IP do host e a porta UDP publicada.
