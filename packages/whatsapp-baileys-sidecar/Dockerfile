# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-alpine AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/whatsapp-baileys-sidecar/package.json packages/whatsapp-baileys-sidecar/package.json
RUN bun install --frozen-lockfile --production --filter @clawdi/whatsapp-baileys-sidecar

FROM oven/bun:1.3.14-alpine AS runtime

RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=dependencies --chown=bun:bun /app/packages/whatsapp-baileys-sidecar/node_modules ./packages/whatsapp-baileys-sidecar/node_modules
COPY --chown=bun:bun packages/whatsapp-baileys-sidecar/package.json packages/whatsapp-baileys-sidecar/package.json
COPY --chown=bun:bun packages/whatsapp-baileys-sidecar/src packages/whatsapp-baileys-sidecar/src

RUN chmod -R a-w /app

USER bun:bun

LABEL service="clawdi-whatsapp-baileys-sidecar"

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "run", "/app/packages/whatsapp-baileys-sidecar/src/healthcheck.ts"]

CMD ["bun", "run", "/app/packages/whatsapp-baileys-sidecar/src/index.ts"]
