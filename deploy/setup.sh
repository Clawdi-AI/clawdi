#!/usr/bin/env bash
# First-time setup of clawdi-cloud backend on the redpill host.
#
# Assumptions:
#   - Host matches existing clawdi deploy pattern (supervisor, nginx, certbot,
#     system postgres 16, uv, user `phala`).
#   - DNS for api.cloud.clawdi.ai points at this box before you run the
#     certbot step (section 5).
#   - You have sudo.
#
# Idempotent up to the git clone and the certbot issuance — rerun-safe.
#
# Usage:  ssh clawdi 'bash -s' < deploy/setup.sh

set -euo pipefail

APP_DIR=/opt/clawdi-cloud
REPO=git@github-clawdi-cloud:Clawdi-AI/clawdi-cloud.git
BRANCH=main
DB_NAME=clawdi_cloud_prod
DB_USER=clawdi_cloud_prod
DOMAIN=api.cloud.clawdi.ai
DEPLOY_KEY=$HOME/.ssh/clawdi_cloud_deploy

blue()  { printf '\033[0;34m==>\033[0m %s\n' "$*"; }
green() { printf '\033[0;32m==>\033[0m %s\n' "$*"; }
yellow(){ printf '\033[0;33m==>\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------
blue "1. Ensure a deploy key exists and is wired into ~/.ssh/config"
# ---------------------------------------------------------------------------
# The repo is INTERNAL on github.com/Clawdi-AI — no anonymous clone. We use
# a dedicated SSH deploy key (not the user's personal key) so it can be
# rotated/revoked from the GitHub UI without disturbing anything else.
if [ ! -f "$DEPLOY_KEY" ]; then
    ssh-keygen -t ed25519 -f "$DEPLOY_KEY" -N "" -C "clawdi-cloud-deploy@redpill"
fi
# Host alias so the rest of the script (and future deploy.sh runs) can use
# git@github-clawdi-cloud:... to pick the right identity.
if ! grep -q "Host github-clawdi-cloud" "$HOME/.ssh/config" 2>/dev/null; then
    cat >> "$HOME/.ssh/config" <<CFG

Host github-clawdi-cloud
    HostName github.com
    User git
    IdentityFile $DEPLOY_KEY
    IdentitiesOnly yes
CFG
    chmod 600 "$HOME/.ssh/config"
fi

# First run: surface the public key so the human can paste it into
# https://github.com/Clawdi-AI/clawdi-cloud/settings/keys/new (tick "Allow
# write access" = NO — read is all deploy needs).
if ! ssh -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
        git@github-clawdi-cloud 2>&1 | grep -q "successfully authenticated"; then
    printf '\n==> Paste this public key at https://github.com/Clawdi-AI/clawdi-cloud/settings/keys/new\n    (read-only deploy key; do NOT enable write access)\n\n'
    cat "$DEPLOY_KEY.pub"
    printf '\nThen rerun this script.\n'
    exit 1
fi

# ---------------------------------------------------------------------------
blue "2. Clone repo (skipped if already present)"
# ---------------------------------------------------------------------------
sudo mkdir -p "$APP_DIR"
sudo chown "$USER":"$USER" "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
    git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
else
    # Re-point remote at the deploy-key alias if it's still the generic URL
    # from a prior clone. Idempotent.
    git -C "$APP_DIR" remote set-url origin "$REPO"
    git -C "$APP_DIR" fetch origin "$BRANCH"
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" reset --hard "origin/$BRANCH"
fi

# ---------------------------------------------------------------------------
blue "3. Install Python deps via uv"
# ---------------------------------------------------------------------------
cd "$APP_DIR/backend"
~/.local/bin/uv sync --frozen --no-dev
# Fastembed downloads ~1GB into a cache dir on the first memory-add call.
# Warm it now on a predictable path so the first real request isn't slow.
export FASTEMBED_CACHE_PATH="$APP_DIR/backend/data/fastembed-cache"
mkdir -p "$FASTEMBED_CACHE_PATH" "$APP_DIR/backend/data/files"

# ---------------------------------------------------------------------------
blue "4. Ensure pgvector is installed on the system postgres"
# ---------------------------------------------------------------------------
# pg16 on redpill ships pg_trgm out of the box but pgvector is a separate
# apt package. Check before installing so reruns don't trigger apt every
# time.
if ! apt list --installed 2>/dev/null | grep -q postgresql-16-pgvector; then
    yellow "Installing postgresql-16-pgvector via apt (requires sudo)"
    sudo apt-get update -qq
    sudo apt-get install -y postgresql-16-pgvector
fi

# ---------------------------------------------------------------------------
blue "5. Provision postgres DB + role + extensions"
# ---------------------------------------------------------------------------
if ! sudo -u postgres psql -lqt | cut -d \| -f1 | grep -qw "$DB_NAME"; then
    yellow "Creating DB $DB_NAME — prompting for a password for role $DB_USER"
    read -r -s -p "New password for $DB_USER: " DB_PASS
    echo
    sudo -u postgres psql <<SQL
CREATE ROLE $DB_USER LOGIN PASSWORD '$(printf %s "$DB_PASS" | sed "s/'/''/g")';
CREATE DATABASE $DB_NAME OWNER $DB_USER;
SQL
    unset DB_PASS
else
    green "DB $DB_NAME already exists — skipping"
fi

# Extensions need SUPERUSER, so we CREATE EXTENSION as postgres, not as the
# app role. Safe to rerun.
sudo -u postgres psql -d "$DB_NAME" <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SQL

# ---------------------------------------------------------------------------
blue "6. Seed .env if missing"
# ---------------------------------------------------------------------------
if [ ! -f "$APP_DIR/backend/.env" ]; then
    yellow ".env missing — copying template. You MUST edit before first start."
    cp "$APP_DIR/backend/.env.example" "$APP_DIR/backend/.env"
    chmod 600 "$APP_DIR/backend/.env"
    cat <<'TIPS'

Required before starting:
    DATABASE_URL           — postgresql+asyncpg://clawdi_cloud_prod:<pw>@localhost/clawdi_cloud_prod
    CLERK_PEM_PUBLIC_KEY   — from the shared clawdi Clerk instance (complete-eel-59)
    VAULT_ENCRYPTION_KEY   — python3 -c "import os; print(os.urandom(32).hex())"
    ENCRYPTION_KEY         — different value from the above; same generation
    CORS_ORIGINS           — ["https://cloud.clawdi.ai"]
    COMPOSIO_API_KEY       — from composio.dev dashboard

    Optional:
    MEMORY_EMBEDDING_MODE  — local (fastembed) or api (OpenAI-compat)

Edit now:  sudoedit /opt/clawdi-cloud/backend/.env
Then rerun this script to continue past this step.
TIPS
    exit 1
fi

# ---------------------------------------------------------------------------
blue "7. Run alembic migrations"
# ---------------------------------------------------------------------------
cd "$APP_DIR/backend"
~/.local/bin/uv run alembic upgrade head

# ---------------------------------------------------------------------------
blue "8. Install supervisor unit"
# ---------------------------------------------------------------------------
sudo cp "$APP_DIR/deploy/supervisor/clawdi-cloud.conf" /etc/supervisor/conf.d/
sudo supervisorctl reread
sudo supervisorctl update
sudo supervisorctl start clawdi-cloud-backend: || true

# ---------------------------------------------------------------------------
blue "9. Install nginx vhost"
# ---------------------------------------------------------------------------
sudo cp "$APP_DIR/deploy/nginx/$DOMAIN.conf" /etc/nginx/sites-available/
sudo ln -sfn "/etc/nginx/sites-available/$DOMAIN.conf" \
             "/etc/nginx/sites-enabled/$DOMAIN.conf"
sudo nginx -t
sudo systemctl reload nginx

# ---------------------------------------------------------------------------
blue "10. Issue TLS cert via certbot (requires DNS resolving already)"
# ---------------------------------------------------------------------------
if ! sudo test -d "/etc/letsencrypt/live/$DOMAIN"; then
    yellow "Running certbot — this fails if DNS hasn't propagated yet."
    sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
        --email "ops@clawdi.ai" || {
        yellow "certbot failed. Point $DOMAIN at this host and rerun."
        exit 1
    }
else
    green "Cert for $DOMAIN already issued — skipping"
fi

# ---------------------------------------------------------------------------
green "Done. curl -fsS https://$DOMAIN/health"
# ---------------------------------------------------------------------------
curl -fsS "https://$DOMAIN/health" && echo
