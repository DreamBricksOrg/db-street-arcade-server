# Snake bridge server — plain Node, zero npm dependencies.

FROM node:20-alpine

WORKDIR /app

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
EXPOSE 9000
EXPOSE 9001/udp

CMD ["node", "server.js"]
