ARG BUN_VERSION=1.3.14
ARG NODE_VERSION=24.18.0
ARG UV_VERSION=0.9.30

FROM oven/bun:${BUN_VERSION} AS bun
FROM node:${NODE_VERSION}-bookworm AS node

FROM ghcr.io/astral-sh/uv:${UV_VERSION}-python3.12-bookworm

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /usr/local/bin/bunx /usr/local/bin/bunx
COPY --from=node /usr/local/bin/node /usr/local/bin/node

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash \
		build-essential \
		ca-certificates \
		curl \
		git \
		postgresql-client \
		rsync \
	&& rm -rf /var/lib/apt/lists/*

ENV HOME=/tmp/clawdi-home \
	CLAWDI_NO_AUTO_UPDATE=1 \
	CLAWDI_NO_UPDATE_CHECK=1 \
	BUN_INSTALL_CACHE_DIR=/var/cache/bun \
	BUN_TMPDIR=/tmp/bun \
	TMPDIR=/tmp \
	UV_CACHE_DIR=/var/cache/uv \
	UV_LINK_MODE=copy \
	UV_PYTHON_DOWNLOADS=never \
	PDM_IGNORE_SAVED_PYTHON=1

WORKDIR /work
RUN chown 1000:1000 /work && chmod 755 /work

COPY docker/test-runner.sh /usr/local/bin/clawdi-test-runner
RUN chmod +x /usr/local/bin/clawdi-test-runner

ENTRYPOINT ["clawdi-test-runner"]
