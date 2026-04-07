# Street Arcade — Backend

> Servidor monolítico Node.js + Fastify para controle de jogos via QR Code e WebSocket em tempo real.

## Stack

| Camada | Tecnologia |
|---|---|
| HTTP / WebSocket | Fastify 5 |
| Banco de dados | MongoDB |
| Cache / Pub-Sub | Redis (ioredis) |
| Gateway UDP | Node.js `dgram` |
| Logger | pino |
| Frontend | HTML + Vanilla JS |

## Início Rápido

```bash
# 1. Dependências
npm install

# 2. Variáveis de ambiente
cp .env.example .env
# Edite o .env com suas configurações

# 3. Desenvolvimento (com watch)
npm run dev
```

## Verificação

```bash
curl http://localhost:3000/health
# → { "status": "ok", "ts": 1234567890 }
```

## Estrutura

```
src/
├── app.js          # Factory do Fastify (boot order de plugins)
├── server.js       # Entry point + graceful shutdown
├── config/
│   └── env.js      # Validação de variáveis de ambiente
├── lib/
│   └── logger.js   # Logger pino centralizado
├── plugins/        # Redis, MongoDB, WebSocket, UDP (fases 2–5)
└── modules/
    ├── session/    # CRUD de sessões (fase 6)
    └── game/       # Handler WebSocket + input routing (fase 4)
public/             # Frontend servido pelo Fastify (fases 7–9)
docs/               # Documentação e plano de desenvolvimento
```

## Fases de Desenvolvimento

Consulte [`docs/PLAN-street-arcade-backend.md`](docs/PLAN-street-arcade-backend.md).
