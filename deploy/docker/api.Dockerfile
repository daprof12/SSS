# API (NestJS) and the migration runner. Build from the repo root:
#   docker build -f deploy/docker/api.Dockerfile -t sss-api .
ARG NODE_VERSION=20.18-alpine

FROM node:${NODE_VERSION} AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/tokens/package.json packages/tokens/
COPY packages/web-ui/package.json packages/web-ui/
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mobile/package.json apps/mobile/
COPY db/package.json db/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts -w @erp/api -w @erp/domain --include-workspace-root
COPY packages/domain packages/domain
COPY apps/api apps/api
RUN npm run build -w @erp/domain && npm run build -w @erp/api
# Production dependencies only for the runtime image.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --omit=dev -w @erp/api -w @erp/domain --include-workspace-root

FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production PORT=4000
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /repo/package.json ./
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/packages/domain/package.json packages/domain/package.json
COPY --from=build --chown=node:node /repo/packages/domain/dist packages/domain/dist
COPY --from=build --chown=node:node /repo/apps/api/package.json apps/api/package.json
COPY --from=build --chown=node:node /repo/apps/api/dist apps/api/dist
COPY --chown=node:node scripts scripts
COPY --chown=node:node db/migrations db/migrations
USER 1000:1000
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
