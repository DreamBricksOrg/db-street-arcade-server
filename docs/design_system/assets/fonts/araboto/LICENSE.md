# Araboto — situação da licença

**Resumo: estes arquivos não têm licença válida para uso comercial. Antes de publicar, compre a licença ou troque a fonte.**

Levantamento de 08/10/2026. Não é parecer jurídico.

## O que os próprios arquivos dizem

Lido da tabela `name` dos TTFs desta pasta:

| Campo | Valor |
|---|---|
| Copyright | `Araboto © (Abd El-Rahman Farahat). 2019. All Rights Reserved` |
| Designer | Abd El-Rahman Farahat (https://www.facebook.com/abdelrahmanFrht) |
| Versão | `Version 1.00;April 17, 2020;…;com.myfonts.easy.farahatdesign.araboto.normal.wfkit2…` |
| Embedding (`OS/2 fsType`) | `4` (Preview & Print) |
| Licença / URL de licença | nenhuma |

- **Origem dos arquivos:** o sufixo `com.myfonts.easy.farahatdesign…wfkit2` indica que foram extraídos de um **kit de webfont da MyFonts**, ou seja, uma cópia de arquivos licenciados para um comprador específico.
- **Direitos:** o designer reserva todos os direitos.

## Onde vieram

- **Origem do download:** os arquivos foram baixados do **Fontmirror** (https://www.fontmirror.com/araboto).
- **O que o Fontmirror diz:** lista o autor como "Unknwon" e a licença como "Free license".
- **Por que não vale:** isso contradiz o copyright embutido nos arquivos, e o Fontmirror não é o detentor dos direitos.

## Onde comprar

A Araboto é vendida na **MyFonts** pelo designer:
- https://www.myfonts.com/collections/araboto-font-farahatdesign
- outra página na MyFonts credita a Waw Type: https://www.myfonts.com/collections/araboto-font-waw-type

Na pesquisa de 08/10/2026, o preço era de US$ 30 por peso ou US$ 120 a família de 6 pesos. O uso no site e no painel precisa da licença **Web** (em geral cobrada por visualizações de página/mês). Leia o EULA no momento da compra.

## O que fazer

1. **Comprar** a família (ou só os pesos usados: Light 300, Normal 400, Medium 500, Bold 700 e Black 900) com licença Web, e guardar o recibo e o EULA nesta pasta.
2. **Trocar os arquivos** pelos do kit comprado e gerar de novo os `.woff2` de `public/assets/fonts/araboto/` (o recorte latino está descrito em `docs/design_system/tokens/fonts.css`).
3. **Até lá**, se precisar publicar: tirar `'Araboto'` de `--font-brand`/`--font-body` em `public/css/tokens.css`, do overlay e dos jogos. A Poppins (licença OFL, livre) volta a ser a fonte, como era antes de 08/10/2026.

**Atenção: o repositório `DreamBricksOrg/db-street-arcade-server` é PÚBLICO (conferido em 08/10/2026), e os TTFs e os `.woff2` chegaram a ser enviados para lá, na branch `feat/n-para-n-instancias`.** Isso é redistribuição pública dos arquivos. Mesmo comprando a licença Web, ela normalmente não permite deixar os arquivos da fonte baixáveis num repositório público. Opções:
- tornar o repositório privado; ou
- tirar os arquivos do repositório (e do histórico, com `git filter-repo` + push forçado) e entregá-los fora do git no deploy.

## Situação em 08/10/2026

Os arquivos foram **retirados do repositório e do histórico**: a branch `feat/n-para-n-instancias` foi reescrita (`git filter-branch`) e enviada com push forçado. Nenhum commit dela contém mais os arquivos, e a `main` nunca os teve. O sistema voltou para a Poppins, e o `.gitignore` barra `public/assets/fonts/` e os TTF/OTF/WOFF2 desta pasta.

O GitHub ainda serve o commit antigo para quem souber o SHA (`c9f2f6905daf4351105766a68af55396ed3055fd`, conferido em 08/10/2026). Para apagar de vez, peça ao suporte do GitHub a remoção de dados sensíveis desse commit (formulário "Remove sensitive data"). Quem tiver clonado a branch antes de 08/10/2026 precisa apagar a cópia local e baixar de novo.

Para religar depois de comprar a licença, reverta as mudanças de fonte do commit que retirou os arquivos (`@font-face` em `public/css/tokens.css` e no overlay, `--font-brand`/`--font-body`, os jogos e o `COPY public/assets/fonts` nos Dockerfiles das pontes). Os arquivos licenciados vão para o servidor fora do git.
