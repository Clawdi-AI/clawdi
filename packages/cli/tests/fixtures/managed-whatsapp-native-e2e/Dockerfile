# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.14
ARG NODE_VERSION=24.19.0
ARG UV_VERSION=0.12.5

FROM oven/bun:${BUN_VERSION} AS bun
FROM node:${NODE_VERSION}-bookworm-slim AS node
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM python:3.13-slim-bookworm AS base

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
COPY --from=node /usr/local/ /usr/local/
COPY --from=uv /uv /uvx /usr/local/bin/

RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		ca-certificates \
		nftables \
		util-linux \
	&& rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 clawdi \
	&& useradd --uid 10001 --gid 10001 --create-home --home-dir /home/clawdi --shell /bin/bash clawdi \
	&& groupadd --gid 10002 egress \
	&& useradd --uid 10002 --gid 10002 --create-home --home-dir /home/egress --shell /bin/bash egress

ENV UV_LINK_MODE=copy

FROM base AS harness-dependencies

WORKDIR /opt/e2e-harness
COPY packages/cli/tests/fixtures/managed-whatsapp-native-e2e/pyproject.toml ./
COPY packages/cli/tests/fixtures/managed-whatsapp-native-e2e/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
	uv sync --frozen --no-dev --no-install-project

FROM base AS cli-dependencies

WORKDIR /workspace
COPY package.json bun.lock ./
COPY patches/libsignal@6.0.0.patch patches/libsignal@6.0.0.patch
COPY apps/web/package.json apps/web/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/whatsapp-baileys-sidecar/package.json packages/whatsapp-baileys-sidecar/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --frozen-lockfile --ignore-scripts --filter './packages/cli'

FROM base AS mitmproxy

COPY packages/cli/tests/fixtures/managed-whatsapp-native-e2e/versions.env /opt/e2e/versions.env
RUN --mount=type=bind,from=e2e_artifacts,source=/,target=/mnt/artifacts,ro \
	. /opt/e2e/versions.env \
	&& printf '%s  %s\n' "${MITMPROXY_SHA256}" /mnt/artifacts/mitmproxy.tar.gz \
		| sha256sum --check --strict \
	&& mkdir -p /opt/mitmproxy \
	&& tar --extract --gzip --file /mnt/artifacts/mitmproxy.tar.gz --directory /opt/mitmproxy \
	&& test -x /opt/mitmproxy/mitmdump

FROM base AS openclaw-stock

COPY packages/cli/tests/fixtures/managed-whatsapp-native-e2e/versions.env /opt/e2e/versions.env
RUN --mount=type=bind,from=e2e_artifacts,source=/,target=/mnt/artifacts,ro \
	--mount=type=cache,target=/var/cache/npm,uid=10001,gid=10001 \
	. /opt/e2e/versions.env \
	&& OPENCLAW_TARBALL=/mnt/artifacts/openclaw.tgz \
		OPENCLAW_EXPECTED_INTEGRITY="${OPENCLAW_INTEGRITY}" \
		node --input-type=module --eval \
			'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; const actual = `sha512-${createHash("sha512").update(readFileSync(process.env.OPENCLAW_TARBALL)).digest("base64")}`; if (actual !== process.env.OPENCLAW_EXPECTED_INTEGRITY) throw new Error(`OpenClaw integrity mismatch: ${actual}`);' \
	&& install --mode=0444 --owner=clawdi --group=clawdi \
		/mnt/artifacts/openclaw.tgz /tmp/openclaw.tgz \
	&& mkdir -p /opt/stock/openclaw-home \
	&& chown -R clawdi:clawdi /opt/stock/openclaw-home \
	&& runuser -u clawdi -- env \
		HOME=/opt/stock/openclaw-home \
		NPM_CONFIG_CACHE=/var/cache/npm \
		npm install --global \
			--prefix /opt/stock/openclaw-home/.openclaw \
			/tmp/openclaw.tgz \
			--ignore-scripts --no-audit --no-fund \
	&& rm /tmp/openclaw.tgz \
	&& OPENCLAW_PLUGIN_INSTALL_ATTEMPT=1 \
	&& until runuser -u clawdi -- env \
		HOME=/opt/stock/openclaw-home \
		NPM_CONFIG_CACHE=/var/cache/npm \
		/opt/stock/openclaw-home/.openclaw/bin/openclaw plugins install \
			--force clawhub:@openclaw/whatsapp; do \
		if [ "${OPENCLAW_PLUGIN_INSTALL_ATTEMPT}" -ge 5 ]; then exit 1; fi; \
		sleep "$((OPENCLAW_PLUGIN_INSTALL_ATTEMPT * 3))"; \
		OPENCLAW_PLUGIN_INSTALL_ATTEMPT="$((OPENCLAW_PLUGIN_INSTALL_ATTEMPT + 1))"; \
	done \
	&& OPENCLAW_VERSION_OUTPUT="$(runuser -u clawdi -- env HOME=/opt/stock/openclaw-home \
		/opt/stock/openclaw-home/.openclaw/bin/openclaw --version)" \
	&& printf '%s\n' "${OPENCLAW_VERSION_OUTPUT}" | grep -F "OpenClaw ${OPENCLAW_VERSION}" \
	&& printf '%s\n' "${OPENCLAW_VERSION_OUTPUT}" | grep -F "$(printf '%s' "${OPENCLAW_COMMIT}" | cut -c1-7)" \
	&& OPENCLAW_PLUGIN_INSPECT="$(runuser -u clawdi -- env HOME=/opt/stock/openclaw-home \
		/opt/stock/openclaw-home/.openclaw/bin/openclaw plugins inspect whatsapp --json)" \
		OPENCLAW_EXPECTED_VERSION="${OPENCLAW_VERSION}" \
		OPENCLAW_EXPECTED_PLUGIN_INTEGRITY="${OPENCLAW_PLUGIN_INTEGRITY}" \
		OPENCLAW_EXPECTED_PLUGIN_NPM_INTEGRITY="${OPENCLAW_PLUGIN_NPM_INTEGRITY}" \
		OPENCLAW_EXPECTED_CLAWPACK_SHA256="${OPENCLAW_PLUGIN_CLAWPACK_SHA256}" \
		node --input-type=module --eval \
			'const value = JSON.parse(process.env.OPENCLAW_PLUGIN_INSPECT); const install = value.install ?? {}; if (value.plugin?.packageName !== "@openclaw/whatsapp" || value.plugin?.version !== process.env.OPENCLAW_EXPECTED_VERSION || install.source !== "clawhub" || install.clawhubChannel !== "official" || install.clawhubPackage !== "@openclaw/whatsapp" || install.version !== process.env.OPENCLAW_EXPECTED_VERSION || install.integrity !== process.env.OPENCLAW_EXPECTED_PLUGIN_INTEGRITY || install.npmIntegrity !== process.env.OPENCLAW_EXPECTED_PLUGIN_NPM_INTEGRITY || install.clawpackSha256 !== process.env.OPENCLAW_EXPECTED_CLAWPACK_SHA256) throw new Error(`unexpected OpenClaw WhatsApp provenance: ${JSON.stringify(install)}`);' \
	&& OPENCLAW_EXPECTED_VERSION="${OPENCLAW_VERSION}" \
		OPENCLAW_EXPECTED_BAILEYS_VERSION="${OPENCLAW_BAILEYS_VERSION}" \
		node --input-type=module --eval \
			'import { readFileSync } from "node:fs"; const root = "/opt/stock/openclaw-home/.openclaw/extensions/whatsapp"; const plugin = JSON.parse(readFileSync(`${root}/package.json`, "utf8")); const baileys = JSON.parse(readFileSync(`${root}/node_modules/baileys/package.json`, "utf8")); if (plugin.name !== "@openclaw/whatsapp" || plugin.version !== process.env.OPENCLAW_EXPECTED_VERSION) throw new Error(`unexpected OpenClaw plugin: ${plugin.name}@${plugin.version}`); if (baileys.name !== "baileys" || baileys.version !== process.env.OPENCLAW_EXPECTED_BAILEYS_VERSION) throw new Error(`unexpected OpenClaw Baileys: ${baileys.name}@${baileys.version}`);'

FROM base AS hermes-stock

COPY packages/cli/tests/fixtures/managed-whatsapp-native-e2e/versions.env /opt/e2e/versions.env
RUN --mount=type=bind,from=e2e_artifacts,source=/,target=/mnt/artifacts,ro \
	--mount=type=cache,target=/var/cache/npm,uid=10001,gid=10001 \
	. /opt/e2e/versions.env \
	&& printf '%s  %s\n' "${HERMES_ARCHIVE_SHA256}" /mnt/artifacts/hermes-agent.tar.gz \
		| sha256sum --check --strict \
	&& mkdir -p /opt/stock/hermes-home/.hermes/hermes-agent \
	&& tar --extract --gzip --file /mnt/artifacts/hermes-agent.tar.gz \
		--directory /opt/stock/hermes-home/.hermes/hermes-agent --strip-components=1 \
	&& chown -R clawdi:clawdi /opt/stock/hermes-home \
	&& runuser -u clawdi -- env \
		HOME=/opt/stock/hermes-home \
		NPM_CONFIG_CACHE=/var/cache/npm \
		npm ci \
			--prefix /opt/stock/hermes-home/.hermes/hermes-agent/scripts/whatsapp-bridge \
			--ignore-scripts --no-audit --no-fund \
	&& BRIDGE_ROOT=/opt/stock/hermes-home/.hermes/hermes-agent/scripts/whatsapp-bridge \
	&& sha256sum "${BRIDGE_ROOT}/package.json" | cut -c1-16 >"${BRIDGE_ROOT}/node_modules/.hermes-pkg-hash" \
	&& HERMES_EXPECTED_VERSION="${HERMES_VERSION}" \
		HERMES_BAILEYS_EXPECTED_VERSION="${HERMES_BAILEYS_VERSION}" \
		HERMES_BAILEYS_EXPECTED_INTEGRITY="${HERMES_BAILEYS_INTEGRITY}" \
		node --input-type=module --eval \
			'import { readFileSync } from "node:fs"; const root = "/opt/stock/hermes-home/.hermes/hermes-agent"; const pyproject = readFileSync(`${root}/pyproject.toml`, "utf8"); if (!pyproject.split("\n").includes(`version = "${process.env.HERMES_EXPECTED_VERSION}"`)) throw new Error("unexpected Hermes package version"); const bridge = `${root}/scripts/whatsapp-bridge`; const lock = JSON.parse(readFileSync(`${bridge}/package-lock.json`, "utf8")); const locked = lock.packages?.["node_modules/@whiskeysockets/baileys"]; const installed = JSON.parse(readFileSync(`${bridge}/node_modules/@whiskeysockets/baileys/package.json`, "utf8")); if (locked?.version !== process.env.HERMES_BAILEYS_EXPECTED_VERSION || locked.integrity !== process.env.HERMES_BAILEYS_EXPECTED_INTEGRITY) throw new Error(`unexpected Hermes Baileys lock: ${locked?.version} ${locked?.integrity}`); if (installed.name !== "@whiskeysockets/baileys" || installed.version !== process.env.HERMES_BAILEYS_EXPECTED_VERSION) throw new Error(`unexpected Hermes Baileys: ${installed.name}@${installed.version}`);'

RUN --mount=type=cache,target=/root/.cache/uv \
	UV_PROJECT_ENVIRONMENT=/opt/hermes-venv uv sync \
		--project /opt/stock/hermes-home/.hermes/hermes-agent \
		--frozen --extra messaging --no-dev --no-install-project

FROM base AS e2e-base

WORKDIR /workspace
COPY --from=harness-dependencies /opt/e2e-harness/.venv /opt/e2e-harness/.venv
COPY --from=cli-dependencies /workspace/node_modules /workspace/node_modules
COPY --from=cli-dependencies /workspace/packages/cli/node_modules /workspace/packages/cli/node_modules
COPY package.json ./
COPY packages/cli/package.json packages/cli/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/cli/src packages/cli/src
COPY packages/shared/src packages/shared/src
COPY packages/cli/egress-addon packages/cli/egress-addon
COPY packages/cli/tests/fixtures/managed-whatsapp-native-e2e packages/cli/tests/fixtures/managed-whatsapp-native-e2e
COPY backend/app backend/app
COPY --from=mitmproxy /opt/mitmproxy /opt/mitmproxy

ENV CLAWDI_RUNTIME_USER=clawdi \
	CLAWDI_RUNTIME_UID=10001 \
	CLAWDI_RUNTIME_GID=10001 \
	CLAWDI_EGRESS_UID=10002 \
	CLAWDI_EGRESS_GID=10002 \
	PYTHONPATH=/workspace/backend

ENTRYPOINT ["/workspace/packages/cli/tests/fixtures/managed-whatsapp-native-e2e/run.sh"]

FROM e2e-base AS openclaw
COPY --from=openclaw-stock --chown=clawdi:clawdi \
	/opt/stock/openclaw-home /opt/stock/openclaw-home

FROM e2e-base AS hermes
COPY --from=hermes-stock --chown=clawdi:clawdi \
	/opt/stock/hermes-home /opt/stock/hermes-home
COPY --from=hermes-stock /opt/hermes-venv /opt/hermes-venv
