FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
ENV PORT=7000 CACHE_DIR=/data/cache
RUN mkdir -p /data/cache && chown -R node:node /data
USER node
EXPOSE 7000
CMD ["node", "server.mjs"]
