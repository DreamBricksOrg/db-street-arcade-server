# Demo: Street Arcade Snake (Standalone)

Esta é uma aplicação demonstrativa completamente isolada (Poderia estar sendo escrita em Unity, Python, C++, etc).
Ela representa o "Totem" (O Jogo final). O Jogo escuta na porta UDP `9001` eventos vindos do backend principal, e roda num servidor HTTP próprio na porta `9000`.

## Como Rodar

1. Em um terminal, certifique-se de que o **Backend Principal do Street Arcade** está rodando (`npm run dev` na pasta raiz).
2. Abra **um novo terminal**, entre na pasta `demo-snake`:
   ```bash
   cd demo-snake
   node server.js
   ```
3. Acesse a tela da TV / Totem abrindo no navegador:
   `http://localhost:9000`

## Como Jogar

1. Vá ao **Painel do Operador do Street Arcade** (`http://localhost:3000`).
2. Digite "Totem IP": `127.0.0.1` e "Porta UDP": `9001`.
3. Clique em **Criar Sessão**.
4. Escaneie o QR Code com o seu celular (Dica: garanta que o celular consegue enxergar a porta 3000 do servidor através do IP da máquina na sua rede Wi-Fi, configurando o `PUBLIC_URL` no .env do servidor principal).
5. No celular, aperte os botões do **D-Pad** ou os botões A/B/X/Y.
6. A cobra respectiva àquele jogador irá spawnar na tela imediatamente e começar a se mover!
7. Caso o jogador morra, aperte o botão **A** no celular para dar Respawn.
