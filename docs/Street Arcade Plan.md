# **PROJETO STREET ARCADE**

Sistema de controle de jogos via celular utilizando QR Code e comunicação em tempo real com totens.

## Visão Geral do Fluxo

O usuário inicia a sessão acessando uma página web via QR code. Esta página representa a sessão do jogo. O *backend* valida a sessão e exibe a interface do Gamepad. O usuário utiliza o celular para controlar o jogo, e o *input* é enviado em tempo real para o Totem, que executa a ação correspondente no jogo.

## Arquitetura Proposta

Celular (Gamepad Web) \-\> WebSocket \-\> Node.js Realtime Server \-\> Redis \-\> UDP Gateway \-\> Unity.

Fluxo: Usuário acessa página via QR code \-\> Acessa página da sessão \-\> Backend valida sessão \-\> Abre tela Gamepad \-\> Usuário controla o jogo \-\> Input enviado em tempo real \-\> Totem executa ação no jogo.

# Backend

## Fastify (Servidor em Tempo Real)

* Manter conexões WebSocket  
* Gerenciar sessões de jogo  
* Repassar *inputs* dos usuários  
* Publicar eventos do jogo  
* Enviar pacotes UDP aos totens (Gateway UDP)

## Redis Pub/Sub (Publish/Subscribe)

* Realizar o *broadcast* de eventos em tempo real  
* Desacoplar a comunicação entre os sistemas

## MongoDB

*  Armazenamento e controle de sessão (Auditoria)

## Comunicação UDP (User Datagram Protocol)

* **Objetivo:** Garantir baixa latência no envio de *inputs* e comunicação com os totens.  
* **Uso:** Envio de *inputs* e mensagens de controle aos totens.


# Celular (Gamepad Web)

## Tecnologias

* HTML  
* JavaScript  
* WebSocket

## Funções Principais

* Entrar na sessão (via leitura do QR Code)  
* Exibir a interface do gamepad  
* Enviar *inputs* de controle em tempo real

# Totem

## Unity

* **Função:** Executar o jogo (*Player*).

## Integração Unity/C\#

Um pacote será desenvolvido em Unity/C\#, responsável pela conexão com o servidor e pela leitura das mensagens recebidas. Este pacote incluirá um dicionário de mensagens, permitindo a inscrição de ações específicas do jogo a partir dos dados recebidos do servidor.

## Próximos Passos (Opcional \- Simulação de Gamepad Físico)

Futuramente, em vez de enviar a mensagem diretamente para o Unity, a mensagem poderá ser encaminhada para um *Bridge* intermediário. Este *Bridge* receberá as mensagens e as inscreverá como *input* de um gamepad virtual através do driver [VigemBusDriver](https://vigembusdriver.com/). Isso permitiria que o controle via celular fosse interpretado como um dispositivo de *input* padrão do sistema operacional.

Arquitetura :Celular (Gamepad Web) \-\> WebSocket \-\> Node.js Realtime Server \> Redis  \-\> UDP Gateway \-\> Unity.

**Futuras Implementações (Pós-MVP)**

Comunicação P2P / WebRTC

Arquitetura P2P

* pesquisar viabilidade de WebRTC para comunicação direta entre clientes  
* criar módulo de signaling no servidor (estabelecer conexão inicial)  
* implementar fallback para WebSocket caso WebRTC falhe  
* documentar trade-offs da abordagem P2P vs servidor central

Fluxo futuro com WebRTC:

Celular A ← WebRTC → Celular B  
↕  
Signaling Server ([Node.js](http://Node.js))

Otimização de Latência

* implementar compressão de pacotes de input  
* criar sistema de interpolação/predição de inputs  
* implementar batching de mensagens para reduzir overhead  
* criar métricas de latência em tempo real (dashboard)  
* definir thresholds aceitáveis de latência por tipo de jogo

Gerenciamento de Jogadores

Sistema de Fila

* criar módulo de fila de espera por sessão  
* implementar lógica de entrada automática quando vaga é liberada  
* criar notificação para jogador na fila (posição, tempo estimado)  
* implementar timeout de fila (remover jogador inativo da fila)  
* criar tela de "Aguardando vaga" no frontend

Fluxo de fila:

Jogador escaneia QR Code  
↓  
Sessão cheia?  
↓ Sim → Entra na fila → Aguarda vaga → Entra na sessão  
↓ Não → Entra direto na sessão

Entrada e Saída Fluida

* implementar hot-join (entrada durante partida em andamento)  
* implementar hot-leave (saída sem interromper a partida)  
* criar evento de "jogador entrou" / "jogador saiu" para o jogo Unity  
* definir mecânicas de jogo que suportem entrada/saída dinâmica  
* criar limites configuráveis de jogadores por sessão


  
Customização de Controles

Configuração por Jogo

* criar schema de configuração de controles (JSON)  
* implementar renderização dinâmica do gamepad (botões, posições, estilos)  
* criar suporte a diferentes tipos de controle (d-pad, joystick, botões customizados)  
* criar editor visual de layout de controles (admin)  
* criar sistema de temas visuais para o gamepad  
* permitir customização de cores e ícones por jogo

Infraestrutura Escalável

DynamoDB / Banco de Sessões

*  avaliar uso de DynamoDB para persistência de sessões  
*  criar módulo de integração com DynamoDB  
*  migrar store de sessões de memória para DynamoDB  
*  implementar TTL automático para sessões expiradas  
* criar dashboard de sessões ativas

Infraestrutura futura:

    AWS  
    ├ Node.js  
    ├ Redis  
    ├ Nginx  
    ├ DynamoDB (sessões)  
    └ CloudWatch (métricas)

Diagrama de Infraestrutura

* criar diagrama Mermaid da arquitetura completa  
* documentar fluxo de dados: celular → servidor → totem  
* documentar fluxo de dados P2P alternativo  
* mapear pontos de falha e estratégias de fallback

Configuração de sessão por totem

* Objeto de configuração por totem  
* Totem conversa com servidor para enviar as configurações de suas sessões  
* Identidade, estilização de gamepad, jogo, endereço físico do totem

