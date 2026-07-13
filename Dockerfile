# Street Arcade Backend — dashboard/API server only.
# Games (games/snake, games/brick-rush) run as separate standalone processes
# and are NOT part of this image.

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
