# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
COPY package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
# Keep npm's download cache across failed builds and retry transient registry
# resets. Low socket concurrency is more reliable on unstable network links.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --workspaces --include-workspace-root --prefer-offline \
      --fetch-retries=5 \
      --fetch-retry-factor=2 \
      --fetch-retry-mintimeout=20000 \
      --fetch-retry-maxtimeout=120000 \
      --fetch-timeout=600000 \
      --maxsockets=3
COPY backend backend
COPY frontend frontend
RUN npm run build
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
RUN apk add --no-cache tini && addgroup -S atlas && adduser -S -G atlas atlas && mkdir -p /data/screenshots && chown -R atlas:atlas /app /data
COPY --from=build --chown=atlas:atlas /app/package.json ./package.json
COPY --from=build --chown=atlas:atlas /app/node_modules ./node_modules
COPY --from=build --chown=atlas:atlas /app/backend/package.json ./backend/package.json
COPY --from=build --chown=atlas:atlas /app/backend/dist ./backend/dist
COPY --from=build --chown=atlas:atlas /app/frontend/dist ./frontend/dist
USER atlas
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=5 CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","backend/dist/index.js"]
