ARG BUN_VERSION=1.4.0
ARG NODE_VERSION=24.19.0

FROM oven/bun:${BUN_VERSION} AS bun
FROM node:${NODE_VERSION}-trixie

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /usr/local/bin/bunx /usr/local/bin/bunx

RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		ca-certificates \
		dbus-user-session \
		systemd \
		systemd-sysv \
	&& rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 clawdi \
	&& useradd --uid 10001 --gid 10001 --create-home --home-dir /home/clawdi --shell /bin/bash clawdi

# `openclaw --version` identifies this published package as official source
# commit 0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c. npm omits gitHead, so the
# registry integrity and the CLI's own commit identity are both verified.
ARG OPENCLAW_VERSION=2026.7.1-2
ARG OPENCLAW_COMMIT=0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c
ARG OPENCLAW_INTEGRITY=sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==
ARG OPENCLAW_NODE_VERSION=24.15.0
RUN npm pack "openclaw@${OPENCLAW_VERSION}" --pack-destination /tmp --silent >/dev/null \
	&& OPENCLAW_TARBALL="/tmp/openclaw-${OPENCLAW_VERSION}.tgz" \
		OPENCLAW_EXPECTED_INTEGRITY="${OPENCLAW_INTEGRITY}" \
		node --input-type=module --eval \
			'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; const actual = `sha512-${createHash("sha512").update(readFileSync(process.env.OPENCLAW_TARBALL)).digest("base64")}`; if (actual !== process.env.OPENCLAW_EXPECTED_INTEGRITY) { throw new Error(`OpenClaw package integrity mismatch: ${actual}`); }' \
	&& OPENCLAW_NODE_DIR="/home/clawdi/.local/tools/node-v${OPENCLAW_NODE_VERSION}" \
	&& mkdir -p "${OPENCLAW_NODE_DIR}" /home/clawdi/.local/bin \
	&& chown -R clawdi:clawdi /home/clawdi/.local \
	&& runuser -u clawdi -- env HOME=/home/clawdi npm install --global \
		--prefix "${OPENCLAW_NODE_DIR}" \
		"/tmp/openclaw-${OPENCLAW_VERSION}.tgz" \
		--ignore-scripts --no-audit --no-fund \
	&& rm "/tmp/openclaw-${OPENCLAW_VERSION}.tgz" \
	&& ln -s /usr/local/bin/node "${OPENCLAW_NODE_DIR}/bin/node" \
	&& ln -s "${OPENCLAW_NODE_DIR}" /home/clawdi/.local/tools/node \
	&& printf '%s\n' \
		'#!/usr/bin/env bash' \
		'set -euo pipefail' \
		"exec \"/home/clawdi/.local/tools/node/bin/node\" \"${OPENCLAW_NODE_DIR}/lib/node_modules/openclaw/dist/entry.js\" \"\$@\"" \
		> /home/clawdi/.local/bin/openclaw \
	&& chown -h clawdi:clawdi \
		/home/clawdi/.local/bin/openclaw \
		/home/clawdi/.local/tools/node \
		"${OPENCLAW_NODE_DIR}/bin/node" \
	&& chmod 0755 /home/clawdi/.local/bin/openclaw \
	&& OPENCLAW_VERSION_OUTPUT="$(runuser -u clawdi -- env HOME=/home/clawdi \
		/home/clawdi/.local/bin/openclaw --version)" \
	&& printf '%s\n' "$OPENCLAW_VERSION_OUTPUT" | grep -F "OpenClaw ${OPENCLAW_VERSION}" \
	&& printf '%s\n' "$OPENCLAW_VERSION_OUTPUT" \
		| grep -F "$(printf '%s' "$OPENCLAW_COMMIT" | cut -c1-7)"

ENV CLAWDI_TEST_OPENCLAW_VERSION=${OPENCLAW_VERSION} \
	CLAWDI_TEST_OPENCLAW_COMMIT=${OPENCLAW_COMMIT} \
	CLAWDI_TEST_OPENCLAW_NODE_VERSION=${OPENCLAW_NODE_VERSION}

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
