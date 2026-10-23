# Clean host for the upstream OpenClaw adapter contract. OpenClaw itself is
# installed at run time with the CLI's official installer policy, exactly like
# a new Hosted Agent.
ARG BUN_VERSION=1.4.0
ARG NODE_VERSION=24.21.0
ARG UBUNTU_VERSION=24.04

FROM oven/bun:${BUN_VERSION} AS bun
FROM node:${NODE_VERSION}-bookworm-slim AS node

FROM ubuntu:${UBUNTU_VERSION}

RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		build-essential \
		ca-certificates \
		curl \
		git \
		libatomic1 \
		xz-utils \
	&& rm -rf /var/lib/apt/lists/*

# The CLI contract itself runs on the Hosted image's current Node. OpenClaw's
# installer provisions its own Node under the tenant prefix and the contract
# verifies that the wrapper uses that bundled runtime.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
	&& ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN groupadd --gid 10001 clawdi \
	&& useradd --uid 10001 --gid 10001 --create-home --home-dir /home/clawdi --shell /bin/bash clawdi \
	&& install -d -m 0755 -o clawdi -g clawdi /work

USER clawdi
ENV HOME=/home/clawdi \
	USER=clawdi \
	LOGNAME=clawdi \
	CLAWDI_NO_AUTO_UPDATE=1 \
	CLAWDI_NO_UPDATE_CHECK=1
WORKDIR /work
