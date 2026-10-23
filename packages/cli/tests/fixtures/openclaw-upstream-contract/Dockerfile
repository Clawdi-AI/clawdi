# Clean host for the upstream OpenClaw adapter contract. OpenClaw itself is
# installed at run time with the CLI's official installer policy, exactly like
# a new Hosted Agent.
ARG BUN_VERSION=1.4.2
ARG NODE_IMAGE

FROM oven/bun:${BUN_VERSION} AS bun
FROM ${NODE_IMAGE}

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
