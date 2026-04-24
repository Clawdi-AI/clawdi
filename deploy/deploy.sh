#!/usr/bin/env bash
# Redeploy clawdi-cloud backend on redpill.
#
# Pulls latest main, syncs deps, runs migrations, restarts supervisor workers.
# Zero-downtime-ish — two workers restart one at a time so nginx keeps at
# least one upstream healthy.
#
# Usage:  ssh clawdi 'bash -s' < deploy/deploy.sh

set -euo pipefail

APP_DIR=/opt/clawdi-cloud
BRANCH=main

blue()  { printf '\033[0;34m==>\033[0m %s\n' "$*"; }
green() { printf '\033[0;32m==>\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------
blue "1. Fetch latest $BRANCH"
# ---------------------------------------------------------------------------
git -C "$APP_DIR" fetch origin "$BRANCH"
BEFORE_SHA=$(git -C "$APP_DIR" rev-parse HEAD)
git -C "$APP_DIR" reset --hard "origin/$BRANCH"
AFTER_SHA=$(git -C "$APP_DIR" rev-parse HEAD)

if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then
    green "Already at $AFTER_SHA. Nothing to deploy."
    exit 0
fi

green "Deploying $BEFORE_SHA → $AFTER_SHA"

# ---------------------------------------------------------------------------
blue "2. Sync Python deps"
# ---------------------------------------------------------------------------
cd "$APP_DIR/backend"
~/.local/bin/uv sync --frozen --no-dev

# ---------------------------------------------------------------------------
blue "3. Apply alembic migrations"
# ---------------------------------------------------------------------------
~/.local/bin/uv run alembic upgrade head

# ---------------------------------------------------------------------------
blue "4. Rolling restart of backend workers"
# ---------------------------------------------------------------------------
# Restart one at a time so nginx upstream always has at least one live server.
for worker in 70 71; do
    sudo supervisorctl restart "clawdi-cloud-backend:clawdi-cloud-backend-80$worker"
    # Wait until that port answers /health before moving to the next.
    for _ in $(seq 1 30); do
        if curl -fsS "http://127.0.0.1:80$worker/health" >/dev/null 2>&1; then
            green "worker 80$worker healthy"
            break
        fi
        sleep 2
    done
done

# ---------------------------------------------------------------------------
green "Deploy $AFTER_SHA complete. Verify: curl https://api.cloud.clawdi.ai/health"
# ---------------------------------------------------------------------------
