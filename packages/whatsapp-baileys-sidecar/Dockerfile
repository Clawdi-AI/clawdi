# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-alpine AS dependencies

WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/whatsapp-baileys-sidecar/package.json packages/whatsapp-baileys-sidecar/package.json
RUN bun install --frozen-lockfile --production --filter @clawdi/whatsapp-baileys-sidecar

FROM oven/bun:1.3.14-alpine AS build

WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/whatsapp-baileys-sidecar/package.json packages/whatsapp-baileys-sidecar/package.json
RUN bun install --frozen-lockfile --filter @clawdi/whatsapp-baileys-sidecar
COPY packages/whatsapp-baileys-sidecar/tsconfig.json packages/whatsapp-baileys-sidecar/tsconfig.json
COPY packages/whatsapp-baileys-sidecar/tsconfig.build.json packages/whatsapp-baileys-sidecar/tsconfig.build.json
COPY packages/whatsapp-baileys-sidecar/src packages/whatsapp-baileys-sidecar/src
RUN bun run --cwd packages/whatsapp-baileys-sidecar build

FROM node:24.18.0-alpine AS runtime

RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/packages/whatsapp-baileys-sidecar/node_modules ./packages/whatsapp-baileys-sidecar/node_modules
COPY --chown=node:node packages/whatsapp-baileys-sidecar/package.json packages/whatsapp-baileys-sidecar/package.json
COPY --from=build --chown=node:node /app/packages/whatsapp-baileys-sidecar/dist packages/whatsapp-baileys-sidecar/dist

RUN chmod -R a-w /app

USER node:node

LABEL service="clawdi-whatsapp-baileys-sidecar"

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
	CMD ["node", "/app/packages/whatsapp-baileys-sidecar/dist/healthcheck.js"]

CMD ["node", "/app/packages/whatsapp-baileys-sidecar/dist/index.js"]
