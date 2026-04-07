# Street Arcade — Estrutura de Tarefas

## BACKEND

### Servidor Node
- [ ] Criar projeto Node
- [ ] Configurar estrutura de pastas
- [ ] Configurar dependências
- [ ] Criar servidor HTTP base
- [ ] Criar sistema de logs
- [ ] Criar config de ambiente (.env)
- [ ] Criar sistema de inicialização de serviços

### WebSocket
- [ ] Criar servidor WebSocket
- [ ] Implementar conexão de cliente
- [ ] Identificar sessão do cliente
- [ ] Mapear conexão → sessão
- [ ] Mapear conexão → player
- [ ] Criar handler de mensagens
- [ ] Criar handler de desconexão
- [ ] Implementar heartbeat
- [ ] Implementar reconexão

### Redis
- [ ] Instalar Redis
- [ ] Criar client Redis no backend
- [ ] Criar publisher
- [ ] Criar subscriber
- [ ] Criar padrão de canais
- [ ] Publicar inputs no canal
- [ ] Assinar eventos da sessão
- [ ] Implementar reconexão Redis
- [ ] Criar logs de eventos

### UDP
- [ ] Criar módulo UDP sender
- [ ] Definir porta padrão
- [ ] Definir formato de pacote
- [ ] Serializar mensagem
- [ ] Implementar envio UDP
- [ ] Mapear sessão → IP do totem
- [ ] Criar sistema de retry opcional
- [ ] Criar logs UDP

### Sessão
- [ ] Criar gerador de sessionID
- [ ] Criar store de sessões
- [ ] Criar endpoint de criação de sessão
- [ ] Associar jogadores à sessão
- [ ] Limitar número de jogadores
- [ ] Criar sistema de timeout
- [ ] Criar sistema de remoção de sessão
- [ ] Sincronizar sessão com Redis

---

## FRONTEND

### QR Code
- [ ] Criar página de entrada
- [ ] Gerar URL com sessionID
- [ ] Gerar QR Code
- [ ] Criar página `/play/:session`
- [ ] Ler sessionID da URL
- [ ] Validar sessão com backend
- [ ] Criar tela de conexão

### Gamepad
- [ ] Criar layout base
- [ ] Criar botões direcionais
- [ ] Criar botões de ação
- [ ] Criar sistema de touch
- [ ] Criar eventos de pressionar botão
- [ ] Criar eventos de soltar botão
- [ ] Criar joystick virtual opcional
- [ ] Criar feedback visual

### WebSocket Client (UDP via backend)
- [ ] Criar client WebSocket
- [ ] Criar sistema de envio de input
- [ ] Serializar mensagem
- [ ] Criar fila de envio
- [ ] Criar heartbeat
- [ ] Criar reconexão automática
- [ ] Criar logs debug

### Sessão JS
- [ ] Ler sessionID da URL
- [ ] Conectar WebSocket com sessionID
- [ ] Registrar player
- [ ] Sincronizar estado da sessão
- [ ] Exibir status de conexão
- [ ] Exibir erro de sessão inválida
- [ ] Reconectar automaticamente
