# Guia de Uso e Integração — Street Arcade

Este documento explica como iniciar o servidor backend, criar sessões de jogo e, principalmente, como integrar seu jogo (o "Totem") para receber os comandos enviados pelos celulares dos jogadores via UDP.

---

## 1. Como Iniciar o Backend

O backend orquestra as conexões e redireciona os comandos dos celulares para os totems (jogos).

### 1.1. Pré-requisitos
*   **Node.js** (v18+)
*   **MongoDB** (rodando localmente na porta 27020 ou via Docker)
*   **Redis** (rodando localmente na porta padrão 6379)

### 1.2. Instalação e Configuração
1.  Na pasta do projeto, instale as dependências:
    ```bash
    npm install
    ```
2.  Crie um arquivo `.env` na raiz do projeto (use o `.env.example` como base):
    ```env
    PORT=3000
    HOST=0.0.0.0
    NODE_ENV=development
    MONGO_URI=mongodb://localhost:27020/street-arcade
    REDIS_URL=redis://localhost:6379
    SESSION_TIMEOUT_MS=300000
    PUBLIC_URL=http://<SEU_IP_NA_REDE>:3000
    ```
    *Dica: Para jogar usando o celular na mesma rede Wi-Fi, altere `PUBLIC_URL` para o IP real da sua máquina na rede local (ex: `http://192.168.1.50:3000`). O `localhost` não funcionará se o celular tentar escanear e acessar.*

### 1.3. Rodando o Servidor
```bash
npm run dev
```

---

## 2. Como Utilizar o Sistema (Fluxo do Operador e Jogador)

1.  **Acesse o Painel do Operador:**
    Abra `http://localhost:3000` no seu navegador desktop.
2.  **Configurar o Totem:**
    No formulário, informe o **IP do Totem** (ex: `127.0.0.1` se o jogo estiver rodando na mesma máquina) e a **Porta UDP** (ex: `9001`) que o jogo está escutando.
3.  **Criar Sessão:**
    Clique em "Criar Sessão". Um QR Code será exibido na tela.
4.  **Jogar:**
    *   Pegue um celular e escaneie o QR Code.
    *   A página do Gamepad virtual será aberta (`http://<IP>:3000/play/<SESSION_ID>`).
    *   Ao apertar os botões na tela, os comandos serão enviados via WebSocket para o backend, que por sua vez enviará datagramas UDP para o IP/Porta configurados no passo 2.

---

## 3. Integrando o Seu Jogo (Recebendo os Comandos UDP)

O objetivo principal do backend é transformar os inputs do celular (WebSocket) em pacotes locais extremamente rápidos (UDP). Seu jogo atuará como um "Servidor UDP" passivo, apenas "escutando" a porta configurada.

### 3.1. Formato do Pacote UDP

Os pacotes enviados pelo backend são strings em formato **JSON compactado** em codificação **UTF-8**.

**Exemplo de Payload:**
```json
{"sid":"87c2bf8a","pid":"p_mobile","a":"btn_A","s":1,"ts":6153826}
```

**Dicionário de Campos:**
*   `sid` (String): Os 8 primeiros caracteres do UUID da sessão. Ignorar comandos de sessões antigas se o seu jogo só deve responder à atual.
*   `pid` (String): ID do jogador. Importante se o jogo tiver múltiplos players (ex: `Player 1` vs `Player 2`).
*   `a` (String): Nome da ação / botão.
    *   Valores possíveis: `dpad_up`, `dpad_down`, `dpad_left`, `dpad_right`, `btn_A`, `btn_B`, `btn_X`, `btn_Y`.
*   `s` (Inteiro): Estado do botão.
    *   `1` = Pressed (Botão pressionado)
    *   `0` = Released (Botão solto)
*   `ts` (Inteiro/Long): Timestamp relativo em milissegundos. Útil para descartar pacotes fora de ordem.

---

### 3.2. Exemplo de Integração em Unity (C#)

Crie um script `GamepadListener.cs` e anexe a um GameObject persistente na sua cena. Certifique-se de configurar a mesma `udpPort` ao criar a sessão no painel do operador.

```csharp
using UnityEngine;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

[System.Serializable]
public class GamepadInput
{
    public string sid; // Session ID (8 chars)
    public string pid; // Player ID
    public string a;   // Action (dpad_up, btn_A, etc)
    public int s;      // State (1=pressed, 0=released)
    public long ts;    // Timestamp
}

public class GamepadListener : MonoBehaviour
{
    public int listenPort = 9001;
    
    private UdpClient udpClient;
    private Thread listenThread;
    private bool isListening;

    void Start()
    {
        udpClient = new UdpClient(listenPort);
        isListening = true;
        listenThread = new Thread(new ThreadStart(ListenForUDP));
        listenThread.IsBackground = true;
        listenThread.Start();
        
        Debug.Log($"[GamepadListener] Escutando comandos UDP na porta {listenPort}");
    }

    private void ListenForUDP()
    {
        IPEndPoint remoteEndPoint = new IPEndPoint(IPAddress.Any, 0);

        while (isListening)
        {
            try
            {
                byte[] receivedBytes = udpClient.Receive(ref remoteEndPoint);
                string jsonString = Encoding.UTF8.GetString(receivedBytes);
                
                // Unity API (JsonUtility) não deve ser chamada direto da thread de rede,
                // mas para este simples JSON, funciona ou você pode enfileirar em uma thread principal (MainThreadDispatcher).
                GamepadInput input = JsonUtility.FromJson<GamepadInput>(jsonString);
                
                // Enfileirar a ação para a Thread Principal
                // (O Unity não deixa alterar Transforms/GameObjects de outras threads)
                MainThreadDispatcher.Enqueue(() => ProcessInput(input));
            }
            catch (SocketException e)
            {
                if (isListening) Debug.LogWarning("Socket exception: " + e.Message);
            }
        }
    }

    private void ProcessInput(GamepadInput input)
    {
        // Aqui você mapeia a entrada para a lógica do seu jogo
        bool isPressed = input.s == 1;

        switch (input.a)
        {
            case "btn_A":
                if (isPressed) Debug.Log($"Player {input.pid} Pulo!");
                break;
            case "dpad_right":
                if (isPressed) Debug.Log($"Player {input.pid} movendo para a direita.");
                else Debug.Log($"Player {input.pid} parou.");
                break;
            // ... Mapear btn_X, btn_Y, btn_B, dpad_up, dpad_down, dpad_left
        }
    }

    void OnApplicationQuit()
    {
        isListening = false;
        if (udpClient != null) udpClient.Close();
        if (listenThread != null) listenThread.Abort();
    }
}
```

*(Nota: O trecho `MainThreadDispatcher.Enqueue` é uma abstração comum para jogar tarefas da Thread de Rede para o `Update()` da Unity).*

---

### 3.3. Exemplo de Integração em Node.js

Para fins de teste ou se você estiver usando um engine web/html baseada no lado do servidor, ouvir UDP em Node.js é extremamente simples:

```javascript
const dgram = require('dgram');
const server = dgram.createSocket('udp4');

const PORT = 9001;

server.on('error', (err) => {
  console.error(`Status de Erro do Servidor:\n${err.stack}`);
  server.close();
});

server.on('message', (msg, rinfo) => {
  try {
    // msg é um Buffer contendo os bytes enviados pelo backend do Street Arcade
    const payload = JSON.parse(msg.toString('utf8'));
    
    const statusText = payload.s === 1 ? 'PRESSIONADO' : 'SOLTO';
    console.log(`[Player: ${payload.pid}] Botão: ${payload.a} -> ${statusText}`);
    
    // Ação específica
    if (payload.a === 'btn_A' && payload.s === 1) {
       console.log('>>> AÇÃO: PULO!');
    }
  } catch (err) {
    console.error('Falha ao parsear pacote JSON:', err);
  }
});

server.on('listening', () => {
  const address = server.address();
  console.log(`Jogo escutando comandos UDP em ${address.address}:${address.port}`);
});

server.bind(PORT);
```
