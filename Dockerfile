# Street Arcade Backend — dashboard/API server.
# Also serves the browser games in games/*/public to embedded iframes
# (/embed/:totemId, GAMES_DIR=/app/games). The standalone game bridges
# (games/*/server.js) used next to a physical cabinet run elsewhere.

FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY games ./games

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
