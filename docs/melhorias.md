# Street Arcade — Lista de melhorias

Levantamento feito em 07/10/2026 sobre a branch `feat/n-para-n-instancias` (instâncias n→n + DreamBricks Design System). Cada item diz o problema, onde ele está e o que fazer.

**Prioridade**
- **Alta**: risco de segurança, quebra em produção ou bloqueia o uso real em evento/site. Fazer antes de publicar.
- **Média**: dívida que custa caro com o tempo (operação, qualidade, desempenho). Planejar para as próximas semanas.
- **Baixa**: acabamento e conveniência. Fazer quando houver folga.

## Situação (07/10/2026)

Os itens de prioridade **alta** e **baixa** foram implementados na branch `feat/n-para-n-instancias` (commits locais `1cdb288` a `a991e60`), com testes: 28 unitários e 4 suítes de ponta a ponta (27 cenários, incluindo dois processos e restart no meio da partida). Os itens de prioridade **média** continuam em aberto, exceto o 11, que saiu junto com o login. O item 18 depende dos arquivos da fonte Araboto.

O que mudou para quem opera:
- **Senha do painel:** `OPERATOR_PASSWORD` no `.env`, obrigatória em produção.
- **Chave do totem:** cada totem físico tem uma chave (painel → Editar → Chave do jogo), que vai em `TOTEM_KEY` no `.env` da ponte do jogo (`games/*/server.js`). Totens antigos seguem funcionando sem chave até alguém gerar uma.
- **Histórico:** botão de gráfico em cada card do painel.

## Resumo

| # | Melhoria | Prioridade | Área | Situação |
|---|----------|-----------|------|----------|
| 1 | Autenticação no painel e nas rotas de operação | **Alta** | Segurança | ✅ feito |
| 2 | Proteger o `end-session` chamado pelo jogo | **Alta** | Segurança | ✅ feito |
| 3 | Incluir `games/` na imagem Docker | **Alta** | Deploy | ✅ feito |
| 4 | Atualizar Node 20 (fora de suporte) | **Alta** | Infra | ✅ feito |
| 5 | Registro de instâncias fora da memória do processo | **Alta** | Escala / resiliência | ✅ feito |
| 6 | Validar e limitar os inputs do WebSocket | Média | Segurança / estabilidade | pendente |
| 7 | CI no GitHub (lint + testes) | Média | Qualidade | pendente |
| 8 | Configuração do ESLint (o `npm run lint` não roda) | Média | Qualidade | pendente |
| 9 | Health check que olha Mongo e Redis | Média | Operação | pendente |
| 10 | `TRUST_PROXY` ligado em produção | Média | Operação | pendente |
| 11 | Esconder o Swagger em produção | Média | Segurança | ✅ feito (junto com o item 1) |
| 12 | Limpeza das sessões encerradas no Mongo | Média | Dados | pendente |
| 13 | Painel: trocar N pollings por um stream único | Média | Desempenho | pendente |
| 14 | Testes de interface (fluxo do jogador e painel) | Média | Qualidade | pendente |
| 15 | Limpar arquivos que não são do projeto | Baixa | Repositório | ✅ feito |
| 16 | Remover os aliases antigos de cor | Baixa | Front-end | ✅ feito |
| 17 | Lugar na fila sobreviver a fechar a aba | Baixa | Experiência do jogador | ✅ feito |
| 18 | Fonte oficial Araboto | Baixa | Marca | ⏸ aguardando arquivos da fonte |
| 19 | Histórico e métricas por totem | Baixa | Produto | ✅ feito |

---

## Alta

### 1. Autenticação no painel e nas rotas de operação
**Problema.** Nenhuma rota tem autenticação. Quem souber a URL do servidor consegue criar, editar e excluir totens, limpar filas, expulsar jogadores e apagar sessões (`POST/PUT/DELETE /api/totems`, `POST /api/totems/:id/queue/clear`, `POST /api/sessions/:id/end`, `DELETE /api/sessions/:id`). O painel em `/` também é aberto. Com o embed n→n o servidor fica exposto na internet, então isso deixa de ser teórico.

**O que fazer.** Login do operador (cookie de sessão ou token) e um `onRequest` que proteja as rotas de escrita e o painel. Continuam públicas só as rotas do jogador: `queue/join`, `queue/status`, `queue/events`, `GET /api/sessions/:id`, `/ws/game`, `/play/*` e `/embed/*`.

### 2. Proteger o `end-session` chamado pelo jogo
**Problema.** `POST /api/totems/:id/end-session` aceita um `playerId` truncado em 8 caracteres e, **sem body, encerra todas as sessões** da instância. É a rota que o jogo físico usa para avisar que alguém morreu, mas qualquer pessoa com o `totemId` (que está no QR) pode derrubar os jogadores.

**O que fazer.** Um segredo por totem (gerado no cadastro e configurado na máquina do jogo), enviado em header e conferido no backend. Como alternativa mínima, aceitar a chamada só do IP do totem. O reset sem body deve ficar exclusivo do operador autenticado (item 1).

### 3. Incluir `games/` na imagem Docker
**Problema.** O `Dockerfile` copia só `src/` e `public/`, e o comentário dele ainda diz que os jogos não fazem parte da imagem. Desde o n→n, o próprio backend serve os jogos em `/embed/:totemId` a partir de `GAMES_DIR` (`./games`). Em produção via Docker, todo iframe vai responder erro.

**O que fazer.** `COPY games ./games` (basta o `public/` de cada jogo) ou montar o volume no `docker-compose.yml`. Depois, um teste rápido da imagem: subir o container e abrir `/embed/:id`.

### 4. Atualizar Node 20 (fora de suporte)
**Problema.** O Node 20 saiu de suporte em 30/04/2026 e não recebe mais correções de segurança. O `Dockerfile` usa `node:20-alpine` e o `package.json` pede `>=20`.

**O que fazer.** Ir para o LTS atual (Node 22 ou 24): atualizar o `Dockerfile` e `engines`, rodar `npm run test:unit` e `npm run test:e2e`.

### 5. Registro de instâncias fora da memória do processo
**Problema.** A lista de iframes abertos fica em memória (`src/lib/instances.js`). Por isso:
- só pode rodar **um processo** do backend;
- um restart ou deploy esquece todas as telas abertas: depois de `INSTANCE_GRACE_MS`, as sessões delas viram `instance_closed` e quem estava jogando cai.

**O que fazer.** Guardar o registro no Redis (hash por totem com `lastSeen`) e usar o Pub/Sub, que já existe, para os streams SSE. Isso permite mais de uma réplica atrás do nginx e deploy sem derrubar partidas.

---

## Média

### 6. Validar e limitar os inputs do WebSocket
**Problema.** `game.handler.js` repassa qualquer `action` que o celular mandar, sem lista de botões válidos e sem limite de mensagens por segundo. Um cliente modificado pode inundar o Redis, o UDP e o SSE do jogo.

**O que fazer.** Aceitar só `dpad_*` e `btn_A|B|X|Y`, só `pressed|released`, e aplicar um limite por socket (por exemplo 30 mensagens/s). Acima disso, descartar e registrar no log.

### 7. CI no GitHub (lint + testes)
**Problema.** Não há `.github/workflows`. Os testes (10 unitários, 3 do Brick Rush e 16 cenários de ponta a ponta) só rodam quando alguém lembra.

**O que fazer.** Um GitHub Actions em todo PR, com serviços `mongo` e `redis`, rodando `lint`, `test:unit`, os testes do Brick Rush e `test:e2e`.

### 8. Configuração do ESLint (o `npm run lint` não roda)
**Problema.** O script `lint` chama o ESLint 9, mas o repositório não tem `eslint.config.js`. O comando falha.

**O que fazer.** Criar um `eslint.config.js` (flat config, regras recomendadas, globals de Node e de browser para `public/` e `games/`) e incluir no CI.

### 9. Health check que olha Mongo e Redis
**Problema.** `GET /health` responde `ok` mesmo com o Mongo ou o Redis fora. O container fica "saudável" sem conseguir criar sessão.

**O que fazer.** Manter `/health` como liveness e criar `/health/ready`, que faz `ping` no Mongo e no Redis. Usar no `HEALTHCHECK` do Docker e no nginx/orquestrador.

### 10. `TRUST_PROXY` ligado em produção
**Problema.** O padrão é `false`. Atrás do nginx, o limite de `queue/join` por IP e o limite de iframes por IP (`MAX_INSTANCES_PER_IP`) enxergam todo mundo com o IP do nginx: em pouco tempo bloqueiam visitantes legítimos.

**O que fazer.** Deixar `TRUST_PROXY=true` no `docker-compose` de produção e garantir que o nginx envie `X-Forwarded-For`. Opcionalmente, avisar no log ao subir em produção sem essa variável.

### 11. Esconder o Swagger em produção
**Problema.** `/documentation` mostra a API inteira, inclusive as rotas de operação, para qualquer pessoa.

**O que fazer.** Desligar em `NODE_ENV=production` ou colocar atrás do mesmo login do painel (item 1).

### 12. Limpeza das sessões encerradas no Mongo
**Problema.** Sessões `finished` nunca são apagadas. Com o embed em sites, cada visitante gera documentos e a coleção só cresce.

**O que fazer.** Índice TTL em `endedAt` (por exemplo 90 dias) ou um job que arquive estatísticas e apague o resto. Se o histórico do item 19 for implementado, agregar antes de apagar.

### 13. Painel: trocar N pollings por um stream único
**Problema.** O painel abre um polling por card a cada 10 s (`/instances`) e outro a cada 5 s no dialog da fila. Com muitos totens e vários operadores, isso vira carga desnecessária e atraso de até 10 s.

**O que fazer.** Um endpoint SSE do operador que envia o estado de todos os totens quando algo muda, reaproveitando os canais `queue:event:*` que já existem.

### 14. Testes de interface (fluxo do jogador e painel)
**Problema.** Os testes cobrem só o backend. Regressões no front (fila, gamepad, dialogs do painel, overlay do embed) só aparecem testando à mão.

**O que fazer.** Testes com Playwright para:
- escanear → fila → gamepad → fim de jogo → "Jogar novamente";
- cadastrar, editar e excluir totem no painel;
- o embed com o overlay do QR, no desktop e no celular.

---

## Baixa

### 15. Limpar arquivos que não são do projeto
**Problema.** O repositório versiona `.agent/` (201 arquivos de outra ferramenta de IA). Na raiz há `sub_out.txt` e `tmp_out.txt`, que são saídas de debug, e o Windows cria `desktop.ini` em `docs/design_system/`.

**O que fazer.** Remover do git e adicionar ao `.gitignore`: `.agent/`, `*_out.txt`, `desktop.ini`.

### 16. Remover os aliases antigos de cor
**Problema.** `public/css/tokens.css` ainda mantém os nomes antigos (`--accent`, `--text-muted`, `--surface2`…), usados pelo `play.html` e por partes do `totem-entry.html`. São dois vocabulários para a mesma coisa.

**O que fazer.** Migrar essas telas para os nomes semânticos do DS (`--surface-*`, `--text-*`, `--border-*`) e apagar o bloco de aliases.

### 17. Lugar na fila sobreviver a fechar a aba
**Problema.** O `playerId` da fila fica no `sessionStorage`. Se o jogador fechar a aba, o navegador do celular descartar a página ou ele trocar de app por muito tempo, perde o lugar e volta para o fim.

**O que fazer.** Guardar no `localStorage` com validade curta (por exemplo 10 minutos) e reaproveitar ao voltar para o mesmo totem e a mesma instância.

### 18. Fonte oficial Araboto
**Problema.** O brandbook pede Araboto, e o design system usa Poppins como substituta, porque a fonte é comercial.

**O que fazer.** Pedir os arquivos `.woff2` à marca e trocar em `tokens/fonts.css` e no `public/css`.

**Situação.** A fonte não está no repositório nem na máquina de desenvolvimento. Com os arquivos em mãos: colocar em `public/assets/fonts/`, declarar `@font-face` para Araboto Bold (700) e Light (300) em `public/css/tokens.css` e pôr `'Araboto'` na frente de `--font-brand` e `--font-body`. Poppins fica como fallback.

### 19. Histórico e métricas por totem
**Problema.** O painel mostra só o agora. Não dá para responder quantas partidas houve no evento, qual o tempo médio de fila ou qual site trouxe mais jogadores.

**O que fazer.** Uma página de detalhe do totem com partidas por hora, espera média, desistências da fila (`no_show`) e, no web, partidas por site. Os tempos e motivos de encerramento já estão nas sessões, falta agregar. O site de origem ainda não é gravado: é preciso salvar o `Referer` da instância ao abrir o iframe.
