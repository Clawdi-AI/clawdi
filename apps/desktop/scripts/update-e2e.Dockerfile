FROM oven/bun:1.4.2 AS bun
FROM node:24.19.0-bookworm
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bunx /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends \
    rsync openssl ca-certificates xvfb xauth libgtk-3-0 libnss3 libnss3-tools \
    libasound2 libgbm1 dbus-x11 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /work /var/cache/bun
USER node
ENV HOME=/work/home BUN_INSTALL_CACHE_DIR=/var/cache/bun BIOME_THREADS=2
WORKDIR /work
