# Snake bridge server — plain Node, zero npm dependencies.
# Build context is the REPO ROOT (see docker-compose.yml): the bridge imports
# games/shared/static.js and serves the brand fonts/marks from public/assets.

FROM node:22-alpine

WORKDIR /app

COPY games/shared ./games/shared
COPY games/snake/server.js ./games/snake/
COPY games/snake/public ./games/snake/public
COPY public/assets/fonts ./public/assets/fonts
COPY public/assets/brand ./public/assets/brand

WORKDIR /app/games/snake
ENV NODE_ENV=production
EXPOSE 9000
EXPOSE 9001/udp

CMD ["node", "server.js"]
