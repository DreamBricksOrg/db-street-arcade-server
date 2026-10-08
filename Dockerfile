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

# Ready = the process answers AND MongoDB + Redis answer (see /health/ready).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "src/server.js"]
