# Brick Rush bridge server — plain Node, zero npm dependencies.

FROM node:20-alpine

WORKDIR /app

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 9100
EXPOSE 9101/udp

CMD ["node", "server.js"]
