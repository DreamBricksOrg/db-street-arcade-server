# Street Arcade — Backend

O celular do visitante vira o controle de um jogo: num totem físico (máquina no evento) ou num jogo incorporado em qualquer site (`<iframe>`). Escaneou o QR, entrou na fila, jogou. Sem app.

Node.js 22 + Fastify 5, MongoDB, Redis, WebSocket, UDP e SSE. Detalhes de arquitetura, rotas, schemas e chaves do Redis estão no [`CLAUDE.md`](CLAUDE.md). O visual segue o [`DESIGN.md`](DESIGN.md) (DreamBricks Design System).

## Rodando local

Precisa de Node 22+, MongoDB e Redis. O `docker-compose.yml` da raiz sobe os dois (portas 27021 e 6380 no host).

```bash
npm install
cp .env.example .env              # ajuste MONGO_URI / REDIS_URL
docker compose up -d mongo redis  # opcional: Mongo + Redis do projeto
npm run dev                       # http://localhost:3000
```

- **Login:** sem `OPERATOR_PASSWORD` no `.env`, o painel abre sem login (só em desenvolvimento). Com ele, `/` leva a `/login`: usuário em branco (ou `admin`) + `OPERATOR_PASSWORD` entra como administrador, que cria as contas da equipe em **Usuários**.
- **Saúde:** `GET /health` (o processo responde) e `GET /health/ready` (Mongo e Redis também).

## Telas

| URL | Quem usa |
|---|---|
| `/` | Operador: totens (pausar, fila, histórico, planilha, Incorporar) |
| `/#evento` | Operador: todos os totens juntos, ranking do evento, planilha |
| `/#apelidos` | Operador: bichos e adjetivos dos apelidos dos jogadores (admin edita) |
| `/#usuarios`, `/#atividade` | Admin: contas da equipe e registro de quem fez o quê |
| `/login` | Operador: usuário + senha (`admin` = `OPERATOR_PASSWORD`) |
| `/play/totem?id=<totemId>` | Celular: entrada pelo QR do totem, fila |
| `/play/<sessionId>` | Celular: o controle |
| `/embed/<totemId>` | O jogo incorporado num site (cada carregamento = partida própria) |
| `/documentation` | Swagger (em produção, só com login) |

## Testes

```bash
npm run lint        # ESLint (o CI usa --max-warnings=0)
npm run test:unit   # sem banco
npm run test:e2e    # sobe o servidor de verdade: precisa de Mongo + Redis
npm run test:ui     # Playwright (desktop + celular): precisa de Mongo + Redis
```

- **Bancos de teste:** use bancos separados, ex.: `MONGO_URI=mongodb://localhost:27021/street-arcade-e2e REDIS_URL=redis://localhost:6380 npm run test:e2e`.
- **Navegador do Playwright:** na primeira vez, `npx playwright install chromium`.
- **CI:** o GitHub Actions (`.github/workflows/ci.yml`) roda tudo isso em PRs e na `main`, e ainda confere as imagens Docker.

## Produção

1. **`.env`:** copie `.env.production.example` para `.env`, preencha e confira:
   ```bash
   npm run ops:check-env       # erros saem com código 1
   ```
   O essencial: `OPERATOR_PASSWORD` longa, `PUBLIC_URL` em https e `TRUST_PROXY=true` atrás do nginx (`nginx.conf`).
2. **Imagem:** `docker compose up -d --build` sobe painel/API (`node:22-alpine`, com `HEALTHCHECK`), Mongo e Redis. Pode rodar mais de uma réplica: as instâncias dos iframes, os limites por IP e o stream do painel são compartilhados pelo Redis.
3. **Chave de cada totem físico:** o jogo da máquina envia `X-Totem-Key` para reportar mortes e ler a fila.
   ```bash
   npm run ops:totem-keys            # lista totens sem chave (não altera nada)
   npm run ops:totem-keys -- --apply # gera e imprime TOTEM_ID/TOTEM_KEY por máquina
   ```
   Também dá para gerar pelo painel, em **Editar → Chave do jogo**. Ponha o `TOTEM_KEY` no `.env` da ponte da máquina (`games/<jogo>/.env`).
4. **Ponte do totem físico:** a ponte (`games/<jogo>/server.js`) roda na máquina do jogo:
   ```bash
   cd games/snake && docker compose up -d --build   # contexto = raiz do repositório
   ```

## Fontes

O brandbook pede a **Araboto**, que é comercial e ainda **não foi licenciada**. O sistema usa a Poppins. Não commite arquivos de fonte: este repositório é público. O que foi levantado e como trocar depois da compra estão em [`docs/design_system/assets/fonts/araboto/LICENSE.md`](docs/design_system/assets/fonts/araboto/LICENSE.md).

## Documentação

- [`CLAUDE.md`](CLAUDE.md): arquitetura, rotas, schemas, Redis, fluxo do jogador
- [`DESIGN.md`](DESIGN.md) / [`PRODUCT.md`](PRODUCT.md): sistema visual e produto
- [`docs/game-integration.md`](docs/game-integration.md): como integrar um jogo (UDP, SSE, `end-session`, chave do totem)
- [`docs/melhorias.md`](docs/melhorias.md): melhorias feitas e pendentes
