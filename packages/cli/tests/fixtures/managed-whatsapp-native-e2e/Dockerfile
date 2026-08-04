# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.14
ARG NODE_VERSION=24.18.0
ARG UV_VERSION=0.11.14

FROM oven/bun:${BUN_VERSION} AS bun
FROM node:${NODE_VERSION}-bookworm AS node
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv
FROM python:3.13-bookworm

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /usr/local/bin/bunx /usr/local/bin/bunx
COPY --from=node /usr/local/ /usr/local/
COPY --from=uv /uv /uvx /usr/local/bin/

RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		nftables \
		util-linux \
	&& rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 clawdi \
	&& useradd --uid 10001 --gid 10001 --create-home --home-dir /home/clawdi --shell /bin/bash clawdi \
	&& groupadd --gid 10002 egress \
	&& useradd --uid 10002 --gid 10002 --create-home --home-dir /home/egress --shell /bin/bash egress

ENV UV_LINK_MODE=copy \
	UV_PROJECT_ENVIRONMENT=/workspace/backend/.venv

WORKDIR /workspace/backend
COPY backend/pyproject.toml backend/uv.lock backend/alembic.ini ./
RUN uv sync --frozen --no-dev --no-install-project

ARG OPENCLAW_VERSION=2026.7.1
ARG OPENCLAW_COMMIT=2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4
ARG OPENCLAW_INTEGRITY=sha512-ge/Xss99CHAjPL/ikmH/UFoiOrjcxDB4sW3y9mhyCD+dYW3wzV7TKbAVdkrXFgAG2d2BjpJofP97zUZ+umxo8g==
RUN mkdir -p /opt/artifacts /opt/stock/openclaw-home \
	&& npm pack "openclaw@${OPENCLAW_VERSION}" --pack-destination /opt/artifacts --silent >/dev/null \
	&& OPENCLAW_TARBALL="/opt/artifacts/openclaw-${OPENCLAW_VERSION}.tgz" \
		OPENCLAW_EXPECTED_INTEGRITY="${OPENCLAW_INTEGRITY}" \
		node --input-type=module --eval \
			'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; const actual = `sha512-${createHash("sha512").update(readFileSync(process.env.OPENCLAW_TARBALL)).digest("base64")}`; if (actual !== process.env.OPENCLAW_EXPECTED_INTEGRITY) throw new Error(`OpenClaw integrity mismatch: ${actual}`);' \
	&& chown -R clawdi:clawdi /opt/stock/openclaw-home \
	&& runuser -u clawdi -- env HOME=/opt/stock/openclaw-home npm install --global \
		--prefix /opt/stock/openclaw-home/.openclaw \
		"/opt/artifacts/openclaw-${OPENCLAW_VERSION}.tgz" \
		--ignore-scripts --no-audit --no-fund \
	&& runuser -u clawdi -- env HOME=/opt/stock/openclaw-home \
		/opt/stock/openclaw-home/.openclaw/bin/openclaw plugins install \
		clawhub:@openclaw/whatsapp \
	&& OPENCLAW_VERSION_OUTPUT="$(runuser -u clawdi -- env HOME=/opt/stock/openclaw-home \
		/opt/stock/openclaw-home/.openclaw/bin/openclaw --version)" \
	&& printf '%s\n' "${OPENCLAW_VERSION_OUTPUT}" | grep -F "OpenClaw ${OPENCLAW_VERSION}" \
	&& printf '%s\n' "${OPENCLAW_VERSION_OUTPUT}" | grep -F "$(printf '%s' "${OPENCLAW_COMMIT}" | cut -c1-7)" \
	&& OPENCLAW_PLUGIN_INSPECT="$(runuser -u clawdi -- env HOME=/opt/stock/openclaw-home \
		/opt/stock/openclaw-home/.openclaw/bin/openclaw plugins inspect whatsapp --json)" \
		OPENCLAW_EXPECTED_VERSION="${OPENCLAW_VERSION}" node --input-type=module --eval \
			'const value = JSON.parse(process.env.OPENCLAW_PLUGIN_INSPECT); const install = value.install ?? {}; if (value.plugin?.packageName !== "@openclaw/whatsapp" || value.plugin?.version !== process.env.OPENCLAW_EXPECTED_VERSION || install.source !== "clawhub" || install.clawhubChannel !== "official" || install.clawhubPackage !== "@openclaw/whatsapp" || install.version !== process.env.OPENCLAW_EXPECTED_VERSION || install.integrity !== "sha256-sdm2t01PGNHeXI+RZz6wW+WHXAEm5CwMNFqlUOsAxmM=" || install.npmIntegrity !== "sha512-oymPNeprQ3jBL89aima9ou0Dfj185JTVF9ic2ccX+ho3dHXALP9TADZpgx3q41JAr8CUlFyfc/a+9MFeYEn7ZQ==" || install.clawpackSha256 !== "b1d9b6b74d4f18d1de5c8f91673eb05be5875c0126e42c0c345aa550eb00c663") throw new Error(`unexpected OpenClaw WhatsApp provenance: ${JSON.stringify(install)}`);' \
	&& node --input-type=module --eval \
		'import { readFileSync } from "node:fs"; const root = "/opt/stock/openclaw-home/.openclaw/extensions/whatsapp"; const plugin = JSON.parse(readFileSync(`${root}/package.json`, "utf8")); const baileys = JSON.parse(readFileSync(`${root}/node_modules/baileys/package.json`, "utf8")); if (plugin.name !== "@openclaw/whatsapp" || plugin.version !== "2026.7.1") throw new Error(`unexpected OpenClaw plugin: ${plugin.name}@${plugin.version}`); if (baileys.name !== "baileys" || baileys.version !== "7.0.0-rc13") throw new Error(`unexpected OpenClaw Baileys: ${baileys.name}@${baileys.version}`);'

ARG HERMES_COMMIT=cc4cab2f592e60a197e796506de9168f74baf3ea
ARG HERMES_ARCHIVE_SHA256=e75ad450f3e0932737bbfff3a0a997d4ed532dd8b5ece024072274791a648679
ARG HERMES_BAILEYS_INTEGRITY=sha512-8JPc8gaaCRykkjW2jxLGQ7/RZGrc7awO7WU+QJocf58eSUI9jAdcuYLynzhAbyU4UWvJJsHImZ+5E/JaZj5ypA==
RUN curl --fail --silent --show-error --location \
		"https://github.com/NousResearch/hermes-agent/archive/${HERMES_COMMIT}.tar.gz" \
		--output /opt/artifacts/hermes-agent.tar.gz \
	&& printf '%s  %s\n' "${HERMES_ARCHIVE_SHA256}" /opt/artifacts/hermes-agent.tar.gz | sha256sum --check --strict \
	&& mkdir -p /opt/stock/hermes-home/.hermes/hermes-agent \
	&& tar --extract --gzip --file /opt/artifacts/hermes-agent.tar.gz \
		--directory /opt/stock/hermes-home/.hermes/hermes-agent --strip-components=1 \
	&& chown -R clawdi:clawdi /opt/stock/hermes-home \
	&& runuser -u clawdi -- env HOME=/opt/stock/hermes-home npm ci \
		--prefix /opt/stock/hermes-home/.hermes/hermes-agent/scripts/whatsapp-bridge \
		--ignore-scripts --no-audit --no-fund \
	&& BRIDGE_ROOT=/opt/stock/hermes-home/.hermes/hermes-agent/scripts/whatsapp-bridge \
	&& sha256sum "${BRIDGE_ROOT}/package.json" | cut -c1-16 >"${BRIDGE_ROOT}/node_modules/.hermes-pkg-hash" \
	&& HERMES_BAILEYS_EXPECTED_INTEGRITY="${HERMES_BAILEYS_INTEGRITY}" node --input-type=module --eval \
		'import { readFileSync } from "node:fs"; const root = "/opt/stock/hermes-home/.hermes/hermes-agent"; const pyproject = readFileSync(`${root}/pyproject.toml`, "utf8"); if (!/^version = "0\.19\.1"$/m.test(pyproject)) throw new Error("unexpected Hermes package version"); const bridge = `${root}/scripts/whatsapp-bridge`; const lock = JSON.parse(readFileSync(`${bridge}/package-lock.json`, "utf8")); const locked = lock.packages?.["node_modules/@whiskeysockets/baileys"]; const installed = JSON.parse(readFileSync(`${bridge}/node_modules/@whiskeysockets/baileys/package.json`, "utf8")); if (locked?.version !== "7.0.0-rc13" || locked.integrity !== process.env.HERMES_BAILEYS_EXPECTED_INTEGRITY) throw new Error(`unexpected Hermes Baileys lock: ${locked?.version} ${locked?.integrity}`); if (installed.name !== "@whiskeysockets/baileys" || installed.version !== "7.0.0-rc13") throw new Error(`unexpected Hermes Baileys: ${installed.name}@${installed.version}`);'

RUN UV_PROJECT_ENVIRONMENT=/opt/hermes-venv uv sync \
		--project /opt/stock/hermes-home/.hermes/hermes-agent \
		--frozen --extra messaging --no-dev --no-install-project

ARG MITMPROXY_VERSION=12.2.3
ARG MITMPROXY_SHA256=2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5
RUN curl --fail --silent --show-error --location \
		"https://downloads.mitmproxy.org/${MITMPROXY_VERSION}/mitmproxy-${MITMPROXY_VERSION}-linux-x86_64.tar.gz" \
		--output /opt/artifacts/mitmproxy.tar.gz \
	&& printf '%s  %s\n' "${MITMPROXY_SHA256}" /opt/artifacts/mitmproxy.tar.gz | sha256sum --check --strict \
	&& mkdir -p /opt/mitmproxy \
	&& tar --extract --gzip --file /opt/artifacts/mitmproxy.tar.gz --directory /opt/mitmproxy \
	&& test -x /opt/mitmproxy/mitmdump

WORKDIR /workspace
COPY . .
RUN bun install --frozen-lockfile

ENV CLAWDI_RUNTIME_USER=clawdi \
	CLAWDI_RUNTIME_UID=10001 \
	CLAWDI_RUNTIME_GID=10001 \
	CLAWDI_EGRESS_UID=10002 \
	CLAWDI_EGRESS_GID=10002 \
	E2E_OPENCLAW_COMMIT=${OPENCLAW_COMMIT} \
	E2E_HERMES_COMMIT=${HERMES_COMMIT} \
	E2E_MITMPROXY_VERSION=${MITMPROXY_VERSION} \
	PYTHONPATH=/workspace/backend

ENTRYPOINT ["/workspace/packages/cli/tests/fixtures/managed-whatsapp-native-e2e/run.sh"]
