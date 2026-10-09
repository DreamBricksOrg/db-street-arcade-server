# Street Arcade — Lista de melhorias

Levantamento feito em 07/10/2026 sobre a branch `feat/n-para-n-instancias` (instâncias n→n + DreamBricks Design System). Cada item diz o problema, onde ele está e o que fazer.

**Prioridade**
- **Alta**: risco de segurança, quebra em produção ou bloqueia o uso real em evento/site. Fazer antes de publicar.
- **Média**: dívida que custa caro com o tempo (operação, qualidade, desempenho). Planejar para as próximas semanas.
- **Baixa**: acabamento e conveniência. Fazer quando houver folga.

## Situação (08/10/2026)

Dos 19 itens, 18 foram implementados na branch `feat/n-para-n-instancias`. Alta e baixa ficaram prontos em 07/10, e média em 08/10. A fonte Araboto (item 18) foi aplicada e depois retirada por falta de licença; veja o item 23 na segunda rodada, no fim deste documento.

Testes:
- 38 unitários e 3 do Brick Rush;
- 5 suítes de ponta a ponta com 39 cenários (inclui dois processos, restart no meio da partida e as pontes dos jogos);
- 11 testes de interface com Playwright, no desktop e no celular.

(Números de 08/10/2026, depois da segunda rodada, abaixo.)

O CI do GitHub roda tudo isso em cada push na `main` e em cada PR, e ainda testa a imagem Docker.

O que mudou para quem opera:
- **Senha do painel:** `OPERATOR_PASSWORD` no `.env`, obrigatória em produção.
- **Chave do totem:** cada totem físico tem uma chave (painel → Editar → Chave do jogo), que vai em `TOTEM_KEY` no `.env` da ponte do jogo (`games/*/server.js`). Totens antigos seguem funcionando sem chave até alguém gerar uma.
- **Histórico:** botão de gráfico em cada card do painel.
- **Painel ao vivo:** o painel atualiza por um stream único, sem recarregar e sem polling por card.
- **Retenção:** sessões encerradas são apagadas depois de `SESSION_RETENTION_DAYS` (90 por padrão).
- **Atrás do nginx:** `TRUST_PROXY=true`. Em produção, o servidor avisa no log quando falta.
- **Prontidão:** `GET /health/ready` confere Mongo e Redis, e o `HEALTHCHECK` do Docker usa essa rota.

## Resumo

| # | Melhoria | Prioridade | Área | Situação |
|---|----------|-----------|------|----------|
| 1 | Autenticação no painel e nas rotas de operação | **Alta** | Segurança | ✅ feito |
| 2 | Proteger o `end-session` chamado pelo jogo | **Alta** | Segurança | ✅ feito |
| 3 | Incluir `games/` na imagem Docker | **Alta** | Deploy | ✅ feito |
| 4 | Atualizar Node 20 (fora de suporte) | **Alta** | Infra | ✅ feito |
| 5 | Registro de instâncias fora da memória do processo | **Alta** | Escala / resiliência | ✅ feito |
| 6 | Validar e limitar os inputs do WebSocket | Média | Segurança / estabilidade | ✅ feito |
| 7 | CI no GitHub (lint + testes) | Média | Qualidade | ✅ feito |
| 8 | Configuração do ESLint (o `npm run lint` não roda) | Média | Qualidade | ✅ feito |
| 9 | Health check que olha Mongo e Redis | Média | Operação | ✅ feito |
| 10 | `TRUST_PROXY` ligado em produção | Média | Operação | ✅ feito |
| 11 | Esconder o Swagger em produção | Média | Segurança | ✅ feito (junto com o item 1) |
| 12 | Limpeza das sessões encerradas no Mongo | Média | Dados | ✅ feito |
| 13 | Painel: trocar N pollings por um stream único | Média | Desempenho | ✅ feito |
| 14 | Testes de interface (fluxo do jogador e painel) | Média | Qualidade | ✅ feito |
| 15 | Limpar arquivos que não são do projeto | Baixa | Repositório | ✅ feito |
| 16 | Remover os aliases antigos de cor | Baixa | Front-end | ✅ feito |
| 17 | Lugar na fila sobreviver a fechar a aba | Baixa | Experiência do jogador | ✅ feito |
| 18 | Fonte oficial Araboto | Baixa | Marca | ⏸ sem licença: usando Poppins |
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


**Situação (08/10/2026).** Foi aplicada e depois **retirada**: os arquivos são de um kit da MyFonts com "All Rights Reserved" do designer, sem licença para uso, e o repositório é público. O sistema voltou para a Poppins e o `.gitignore` bloqueia arquivos de fonte. Levantamento, onde comprar e como religar: `docs/design_system/assets/fonts/araboto/LICENSE.md`.

### 19. Histórico e métricas por totem
**Problema.** O painel mostra só o agora. Não dá para responder quantas partidas houve no evento, qual o tempo médio de fila ou qual site trouxe mais jogadores.

**O que fazer.** Uma página de detalhe do totem com partidas por hora, espera média, desistências da fila (`no_show`) e, no web, partidas por site. Os tempos e motivos de encerramento já estão nas sessões, falta agregar. O site de origem ainda não é gravado: é preciso salvar o `Referer` da instância ao abrir o iframe.

---

## Segunda rodada (08/10/2026)

Pontos levantados depois dos 19 itens. Todos na branch `feat/n-para-n-instancias`.

| # | Melhoria | Prioridade | Situação |
|---|----------|-----------|----------|
| 20 | Dependências com falhas de segurança (`npm audit`: 11, sendo 7 altas) | **Alta** | ✅ feito: 0 alertas |
| 21 | CI nunca rodou no GitHub | **Alta** | aguardando abrir o PR |
| 22 | Configurar produção (senha, `TRUST_PROXY`, chaves dos totens antigos) | **Alta** | ✅ ferramentas prontas; falta aplicar no servidor |
| 23 | Licença da Araboto | **Alta** | ✅ verificado: sem licença; voltamos para a Poppins |
| 24 | Limites por IP só na memória de cada processo | Média | ✅ feito: Redis |
| 25 | Araboto e testes na ponte do totem físico | Média | ✅ feito, e corrigida uma falha de segurança |
| 26 | Documentação desatualizada | Média | ✅ feito |
| 27 | Uma senha só para todos os operadores (sem usuários nem auditoria) | Baixa | ✅ resolvido pelo item 34 (usuários + atividade) |
| 28 | Merge na `main` e limpeza do ambiente local de testes | Baixa | aguardando seus testes |

### O que mudou

- **20, dependências.** Subimos `fastify` para 5.12.5, `@fastify/static` para 10 e `@fastify/swagger-ui` para 6, e as indiretas (`ws`, `fast-uri`, `find-my-way`…) foram corrigidas com `npm audit fix`. Testando as falhas de desvio de rota, apareceram duas brechas na guarda de páginas do próprio projeto: `/index%2Ehtml` abria o HTML do painel e `/%64ocumentation` abria o Swagger em produção sem login (os dados da API seguiam protegidos). A guarda agora compara o caminho já decodificado e normalizado, com testes.
- **22, produção.**
  - `.env.production.example` é o modelo do `.env` de produção.
  - `npm run ops:check-env` aponta erros e avisos do `.env`; o servidor repete os avisos ao subir em produção.
  - `npm run ops:totem-keys` lista os totens sem chave e, com `--apply`, gera as chaves.
  - O painel marca com **Sem chave** os totens físicos sem chave.
  - Ninguém mexeu no banco nem no `.env` de produção: aplicar é com a equipe.
- **23, Araboto.** Os arquivos dizem "© Abd El-Rahman Farahat, All Rights Reserved" e vêm de um kit de webfont da MyFonts; o "grátis" do Fontmirror não vale. O repositório no GitHub é **público**, então os arquivos ficaram expostos. Foram retirados dos arquivos **e do histórico** da branch (reescrita com push forçado), e o sistema voltou para a Poppins. O GitHub ainda serve o commit antigo pelo SHA até o suporte apagar (detalhes no `LICENSE.md` da fonte).
- **24, limites.** Entrada na fila e tentativas de login contam no Redis (`rl:{nome}:{ip}:{janela}`), somando todos os processos. Sem Redis, cada processo conta sozinho.
- **25, pontes.** A ponte local (`games/*/server.js`) servia qualquer arquivo: `GET /../.env` devolvia o `.env` da máquina, com a chave do totem. Isso foi confirmado no código antigo. Agora `games/shared/static.js` só serve o que está em `public/`, mais a marca do repositório. As portas aceitam `BRIDGE_HTTP_PORT`/`BRIDGE_UDP_PORT`, as imagens Docker das pontes usam Node 22 com contexto na raiz do repositório, e `tests/e2e/bridges.e2e.mjs` testa as duas pontes.
- **26, documentação.** Foram atualizados `CLAUDE.md`, `README.md` (que só falava de `npm run dev`), `DESIGN.md` (de volta à Poppins) e o arquivo de apoio do impeccable (`.impeccable/design.json`), que ainda tinha a cor laranja aposentada e componentes antigos.

---

## Terceira rodada: funcionalidades (08/10/2026)

O que faltava de funcionalidade, levantado no código em 08/10/2026. As decisões são do produto: o item 30 foi descartado e o 31 foi redefinido.

| # | Funcionalidade | Prioridade | Situação |
|---|----------------|-----------|----------|
| 29 | Avisar o jogador quando chega a vez (vibração, som, título da aba, notificação) | **Alta** | ✅ feito: botão "Me avise quando for a minha vez" arma som, vibração e notificação (service worker `/sw.js`); ao ser chamado, tela "É a sua vez!" antes do controle |
| 30 | Tempo restante no controle | — | descartado: o Snake não tem tempo limite, a partida acaba quando o jogador morre |
| 31 | Nome do jogador → **apelido de animal gerado** ("Capivara Veloz"), sem o jogador digitar nada; listas editáveis no painel | **Alta** | ✅ feito: 30 bichos × 26 adjetivos neutros, sem repetir na mesma tela; aparece no celular, no jogo (`nm`), na fila do operador e no ranking; seção **Apelidos** (admin edita) |
| 32 | Ranking (pontos guardados no backend, placar do dia/evento) | Média | ✅ feito: `score` no `end-session`; placar no histórico do totem, na seção Evento e no lobby do Snake e do Brick Rush |
| 33 | Pausar um totem (fecha a entrada da fila para manutenção/intervalo) | **Alta** | ✅ feito: botão no cartão; entrada responde 423, fila espera, quem joga termina; retomar chama a fila |
| 34 | Usuários individuais de operador, com papéis e registro de atividade | Média | ✅ feito: seções **Usuários** e **Atividade** (admin); login por usuário; `admin` + senha do servidor continua valendo |
| 35 | Exportar o histórico em CSV | Média | ✅ feito: "Exportar planilha" no histórico do totem e na seção Evento (`;` + BOM, abre direto no Excel) |
| 36 | Histórico do evento inteiro (todos os totens juntos) | Média | ✅ feito: seção **Evento** com indicadores, gráfico, partidas por totem e ranking geral |
| 37 | Sites permitidos por totem (`frame-ancestors` por jogo) | Baixa | pendente |
| 38 | Configuração do jogo por formulário (sem editar JSON) | Média | ✅ feito: `games/<jogo>/config.schema.json`; durações em segundos; JSON avançado para extras; servidor valida a faixa |
| 39 | Mais jogos além de Snake e Brick Rush | Baixa | pendente |
