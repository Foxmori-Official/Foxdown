# Foxdown — headless Docker deployment
# Multi-stage: deps -> runtime. Linux aria2/ffmpeg come from the Alpine repos
# (the repo's bin/ ships Windows .exe binaries and is excluded via .dockerignore).

# ---- stage 1: install production node_modules ------------------------------
FROM node:20-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- stage 2: runtime ------------------------------------------------------
FROM node:20-alpine

# Linux builds of the download/stream engines (Alpine official repos)
RUN apk add --no-cache aria2 ffmpeg \
 && addgroup -S foxdown && adduser -S foxdown -G foxdown

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
COPY web/dist ./web/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /data /downloads \
 && chown -R foxdown:foxdown /data /downloads /app

USER foxdown

EXPOSE 16801

ENTRYPOINT ["docker-entrypoint.sh"]
