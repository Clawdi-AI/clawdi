# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.13 AS deps

WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.base.json biome.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/whatsapp-baileys-sidecar/package.json packages/whatsapp-baileys-sidecar/package.json

RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder

ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_CLAWDI_HOSTED=
ARG NEXT_PUBLIC_DEPLOY_API_URL=http://localhost:50021

ENV NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL}" \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}" \
    NEXT_PUBLIC_CLAWDI_HOSTED="${NEXT_PUBLIC_CLAWDI_HOSTED}" \
    NEXT_PUBLIC_DEPLOY_API_URL="${NEXT_PUBLIC_DEPLOY_API_URL}" \
    NODE_ENV=production

COPY . .

RUN bun run --cwd apps/web build

FROM oven/bun:1.3.13 AS runtime

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY --from=builder --chown=bun:bun /app /app

WORKDIR /app/apps/web

USER bun

EXPOSE 3000

CMD ["bun", "run", "start", "--hostname", "0.0.0.0", "--port", "3000"]
