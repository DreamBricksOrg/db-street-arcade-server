# Brick Rush bridge server — plain Node, zero npm dependencies.
# Build context is the REPO ROOT (see docker-compose.yml): the bridge imports
# games/shared/static.js and serves the brand marks from public/assets.

FROM node:22-alpine

WORKDIR /app

COPY games/shared ./games/shared
COPY games/brick-rush/server.js ./games/brick-rush/
COPY games/brick-rush/public ./games/brick-rush/public
COPY public/assets/brand ./public/assets/brand

WORKDIR /app/games/brick-rush
ENV NODE_ENV=production
EXPOSE 9100
EXPOSE 9101/udp

CMD ["node", "server.js"]
