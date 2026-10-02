FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS bun
FROM node:24.21.0-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

ENV HOME=/tmp/home \
	BUN_INSTALL_CACHE_DIR=/tmp/bun-cache \
	EXPO_NO_TELEMETRY=1 \
	CI=1 \
	GOMAXPROCS=2

WORKDIR /work
RUN chown 1000:1000 /work
USER 1000:1000
ENTRYPOINT ["bash", "/probe/container.sh"]
