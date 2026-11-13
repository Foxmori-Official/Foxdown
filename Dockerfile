# Build current artwork and Web UI directly from a clean source checkout.
FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY extension/gen-icons.js ./extension/
COPY extension/icons/icon-source.png ./extension/icons/
RUN npm run assets
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci
COPY web ./web
RUN npm --prefix web run build

FROM node:22-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine

# Linux builds of the download/stream engines (Alpine official repos)
RUN apk add --no-cache aria2 ffmpeg \
 && deluser node \
 && (delgroup node 2>/dev/null || true) \
 && addgroup -g 1000 foxdown \
 && adduser -D -u 1000 -G foxdown foxdown

ENV NODE_ENV=production \
    FOXDOWN_HOST=0.0.0.0 \
    FOXDOWN_PORT=16801 \
    FOXDOWN_BIN_DIR=/usr/bin \
    DATA_DIR=/data \
    DOWNLOAD_DIR=/downloads \
    API_TOKEN=

WORKDIR /app

COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY LICENSE ./LICENSE
COPY --from=web /app/web/dist ./web/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data /downloads \
 && chown -R foxdown:foxdown /data /downloads /app

USER foxdown

EXPOSE 16801

ENTRYPOINT ["docker-entrypoint.sh"]
