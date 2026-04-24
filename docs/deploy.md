# Deploy runbook

Clawdi Cloud deploys in two halves that talk over HTTPS:

| Piece | Where | How |
|---|---|---|
| **Next.js dashboard** | Vercel, `cloud.clawdi.ai` | `vercel deploy` from `apps/web/` (or GitHub integration) |
| **FastAPI backend** | `redpill` (ssh `clawdi`), `api.cloud.clawdi.ai` | supervisor + uv + nginx + certbot (mirrors the `clawdi` deploy pattern on the same box) |
| **Postgres** | Same redpill box, system `postgresql@16-main` service | Reuses the already-running pg16; dedicated `clawdi_cloud_prod` DB + role |

No Docker, no k8s. Backend runs directly on the host under the `phala` user, managed by the existing supervisord.

---

## First-time setup (backend)

Done **once**, after DNS for `api.cloud.clawdi.ai` points at the redpill box.

```bash
# From a local clone of the repo.
ssh clawdi 'bash -s' < deploy/setup.sh
```

The script stops and tells you to edit `.env` the first time — fill in the secrets (see below), then rerun. Idempotent, so it picks up where it stopped.

### Secrets to put in `/opt/clawdi-cloud/backend/.env`

Generated once, then never rotated unless compromised:

```ini
DATABASE_URL=postgresql+asyncpg://clawdi_cloud_prod:<password-you-picked>@localhost/clawdi_cloud_prod

# Same Clerk instance as the main clawdi project ("complete-eel-59"). Grab the
# PEM from https://dashboard.clerk.com → API keys → JWT public key (pem).
CLERK_PEM_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"

# Generate each with: python3 -c "import os; print(os.urandom(32).hex())"
# MUST differ — one encrypts vault data at rest, the other signs MCP JWTs.
VAULT_ENCRYPTION_KEY=<64 hex chars>
ENCRYPTION_KEY=<64 hex chars>

CORS_ORIGINS=["https://cloud.clawdi.ai"]

COMPOSIO_API_KEY=ak_...   # from composio.dev
```

Defaults that are fine for prod as-is (omit to use them):

```ini
FILE_STORE_TYPE=local
FILE_STORE_LOCAL_PATH=/opt/clawdi-cloud/backend/data/files
MEMORY_EMBEDDING_MODE=local
MEMORY_EMBEDDING_MODEL=text-embedding-3-small
```

Keep `.env` at mode `600` and owned by `phala`. If you need to rotate,
`cp .env .env.bak-$(date +%Y%m%d-%H%M%S)` first — that's what the existing
clawdi deploy does.

---

## Daily redeploy (backend)

After a PR merges to `main`:

```bash
ssh clawdi 'bash -s' < deploy/deploy.sh
```

What it does:
1. `git fetch origin main && git reset --hard`
2. `uv sync --frozen --no-dev`
3. `alembic upgrade head`
4. Restarts the two uvicorn workers one at a time, waiting for `/health` between them — nginx keeps one live upstream throughout, so requests don't blackhole.

If a migration is expected to be slow (GIN / HNSW index build), either
deploy during a low-traffic window or run the migration by hand first and
let step 3 be a no-op.

---

## Frontend (Vercel)

Dashboard ships to Vercel from `apps/web/`. Once:

1. In the Vercel dashboard, import the repo.
2. **Root Directory** = `apps/web`. Framework preset = Next.js.
3. Environment variables (Production scope):

    ```
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...   # shared Clerk instance
    CLERK_SECRET_KEY=sk_live_...
    NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
    NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
    NEXT_PUBLIC_API_URL=https://api.cloud.clawdi.ai
    ```

4. Add `cloud.clawdi.ai` as a custom domain; Vercel handles TLS.
5. Every push to `main` auto-deploys preview; promote to prod from the PR.

Don't put any server-side secrets here. The Vercel deployment is a thin
Next.js client — all privileged work happens on `api.cloud.clawdi.ai`.

---

## Ports on redpill

We share the box with several other apps, so the port map matters:

```
8020,8021 redpill-api
8030      spore-hono
8040      redpill-chatgpt-backend
8050      redpill-chatgpt-webapp
8060,8061 clawdi (main)
8070,8071 clawdi-cloud (this repo) ← new
```

Nginx upstream for this app is `127.0.0.1:8070` + `127.0.0.1:8071`.

---

## Rollback

Cheapest path: redeploy an older SHA.

```bash
ssh clawdi
cd /opt/clawdi-cloud && git fetch origin && git checkout <old-sha>
cd backend && uv sync --frozen --no-dev
# If the bad deploy included a migration, also: uv run alembic downgrade -1
sudo supervisorctl restart clawdi-cloud-backend:
```

If the migration is destructive (rare), back up the DB first:

```bash
sudo -u postgres pg_dump clawdi_cloud_prod | gzip > /tmp/clawdi_cloud_prod-$(date +%F).sql.gz
```

---

## Observability

Logs:

```bash
sudo tail -f /var/log/supervisor/clawdi-cloud-backend.log
sudo tail -f /var/log/nginx/clawdi-cloud-backend-{access,error}.log
```

Sentry: set `SENTRY_DSN` in `.env` to enable; same `app/core/sentry.py` that
main clawdi uses, just a separate project ID so errors aren't mixed.

Postgres:

```bash
sudo -u postgres psql clawdi_cloud_prod
```

---

## Troubleshooting

**`/health` returns 500 on first boot after deploy.** Fastembed is downloading
its ONNX model (~1GB) on first memory-add. That path isn't gated behind
`/health`, so `/health` itself should still be 200. If you see a real 500,
check the supervisor log for DB connection / migration errors.

**502 Bad Gateway from nginx.** Either both uvicorn workers are dead
(`supervisorctl status`) or the port map is wrong. Verify with
`sudo ss -tlnp | grep 8070`.

**`InvalidTag` / `authentication failed` on vault reads.** `VAULT_ENCRYPTION_KEY`
has changed since the data was written. There is no recovery — the key is
supposed to be write-once. Restore from a DB backup that predates the key
change.

**Migration fails on `CREATE EXTENSION vector;`.** The extension wasn't
installed on the pg16 cluster. Run
`sudo -u postgres psql clawdi_cloud_prod -c "CREATE EXTENSION vector;"` and
retry.
