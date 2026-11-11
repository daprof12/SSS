# Dashboard and citizen/officer PWA (Next.js). One file, the app is a build argument:
#   docker build -f deploy/docker/web.Dockerfile --build-arg APP=dashboard --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t sss-dashboard .
#   docker build -f deploy/docker/web.Dockerfile --build-arg APP=mobile    --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t sss-mobile .
ARG NODE_VERSION=20.18-alpine

FROM node:${NODE_VERSION} AS build
ARG APP
# NEXT_PUBLIC_* values are compiled into the browser bundle, so they are set at build time.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SMS_NUMBER
ARG NEXT_PUBLIC_TILES_MAP
ARG NEXT_PUBLIC_TILES_SATELLITE
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone \
    NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} NEXT_PUBLIC_SMS_NUMBER=${NEXT_PUBLIC_SMS_NUMBER} \
    NEXT_PUBLIC_TILES_MAP=${NEXT_PUBLIC_TILES_MAP} NEXT_PUBLIC_TILES_SATELLITE=${NEXT_PUBLIC_TILES_SATELLITE}
WORKDIR /repo
RUN test -n "$APP" && test -n "$NEXT_PUBLIC_API_URL" || (echo "APP and NEXT_PUBLIC_API_URL build args are required" && exit 1)
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY packages/tokens/package.json packages/tokens/
COPY packages/web-ui/package.json packages/web-ui/
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mobile/package.json apps/mobile/
COPY db/package.json db/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts -w @erp/${APP} -w @erp/domain -w @erp/tokens -w @erp/web-ui --include-workspace-root
COPY packages packages
COPY apps/${APP} apps/${APP}
RUN npm run build:packages && npm run build -w @erp/${APP} && mkdir -p apps/${APP}/public

FROM node:${NODE_VERSION} AS runtime
ARG APP
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 APP=${APP}
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/${APP}/.next/static apps/${APP}/.next/static
COPY --from=build --chown=node:node /repo/apps/${APP}/public apps/${APP}/public
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "exec node apps/$APP/server.js"]
