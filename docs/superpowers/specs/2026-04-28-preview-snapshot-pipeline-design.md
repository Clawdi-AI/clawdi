# Preview Snapshot Pipeline (Coolify + Cloudflare Tunnel)

**Status:** Design — for team review
**Date:** 2026-04-28

## Problem

`cloud.clawdi.ai` is the production deployment. The team experiments fast and
wants every PR / branch to get its own ephemeral preview environment that
looks like prod (real-shaped data, working web + API, real DNS) so reviewers
can poke at proposed changes against realistic load without breaking
customers. Production-data freshness is not critical — a snapshot refreshed
manually now and then is enough.

Two earlier shapes were considered and discarded:

- **Operator runs a `fork.sh up <slug>` script on the prod VM.** Works, but
  every preview is a manual action by whoever's reviewing. Doesn't scale to
  "every PR."
- **Coolify on the prod VM with per-PR forks of the live prod DB.**
  Co-locating preview workloads on the prod box creates resource and
  blast-radius concerns we don't want.

The chosen shape: **Coolify on a separate office server, fed by manually-
refreshed snapshots of prod.**

## Goals

- One PR / branch on GitHub → one Coolify preview at a stable hostname.
- Each preview boots from a precomputed snapshot containing *only*
  `@phala.network` users — keeps zero-trust posture even though the
  Coolify host is on the office network.
- Snapshot refresh is operator-triggered today (just a `dump.sh` invocation
  on the prod VM, scp'd to the office). No automation in v1.
- TLS / DNS handled by Cloudflare Tunnel + Universal SSL — no certbot,
  no inbound ports on the office server.
- Preview teardown is automatic when the PR is closed/merged.

## Non-goals

- Not auto-refreshing snapshots. Out of scope until pain shows up.
- Not multi-region, not high-availability. One Coolify host, one snapshot.
- Not isolating previews from each other at network level — they all run
  on the same trusted office host with the same snapshot.
- Not a security boundary against an attacker with shell on the office
  Coolify server. Snapshots reuse prod's encryption keys; the data is in
  cleartext blast radius once the host is compromised.

## Architecture

```
                            ┌──────────────────────────────────────┐
                            │  prod VM (clawdi)                    │
   operator runs            │                                       │
   deploy/snapshot/dump.sh ─┤   pg_dump prod → temp DB → prune     │
   on the prod VM           │   → pg_dump pruned → tar with files  │
                            │   → /tmp/clawdi-snapshot-YYYY-MM-DD.tar.gz
                            └──────────────────────────────────────┘
                                          │  scp (manual)
                                          ▼
                            ┌──────────────────────────────────────┐
                            │  office Coolify server (no public IP) │
                            │                                       │
                            │  /var/clawdi-snapshots/latest.tar.gz  │
                            │                                       │
                            │  Coolify (self-hosted)                │
                            │   ├─ coolify-proxy (Traefik)          │
                            │   ├─ cloudflared (in coolify net)     │
                            │   └─ per-PR preview projects:         │
                            │      ├─ postgres (pgvector)           │
                            │      ├─ api (python:3.12-slim)        │
                            │      ├─ web (oven/bun:1)              │
                            │      └─ restore (alpine + psql; one-shot)
                            │         mounts /var/clawdi-snapshots:ro
                            └────────────┬─────────────────────────┘
                                         │ outbound persistent conn
                                         ▼
                            ┌──────────────────────────────────────┐
                            │  Cloudflare edge (Universal SSL)      │
                            │  *.clawdi.ai (CNAME → tunnel-id)      │
                            └──────────────────────────────────────┘
                                         ▲
                                         │ HTTPS
                                       client
```

## DNS and TLS

Universal SSL on the free Cloudflare plan covers **one label below the
apex** only. So `foo.clawdi.ai` is covered, `foo.preview.clawdi.ai` is not.

To stay on the free plan and avoid Cloudflare Advanced Certificate Manager
(~$10/mo per zone), preview hostnames live one level under the apex:

- web: `<pr_id>-preview.clawdi.ai`
- api: `<pr_id>-preview-api.clawdi.ai`

DNS in Cloudflare for `clawdi.ai`:

- **Add:** `CNAME *.clawdi.ai → <tunnel-id>.cfargotunnel.com` (proxied).
- **Verify** that any *explicit* one-label records that already exist
  (`api.clawdi.ai`, `cloud-api.clawdi.ai`, `cloud.clawdi.ai`, etc.) are
  unaffected — explicit records always win over wildcards.
- **Remove** any obsolete `*.preview.clawdi.ai` records left over from
  earlier exploration. Two-label wildcards aren't useful here.

Cloudflare SSL/TLS mode for the zone: **Full** (not Full Strict). Cloudflare
terminates TLS at the edge with the Universal SSL cert; tunnel → coolify-
proxy is HTTP within the trusted Docker network.

## Data filter — why dump-and-prune at snapshot time

The schema has no real foreign keys on `user_id` (every user-owned table
declares `user_id` as a plain `UUID` column with `index=True` but no
`ForeignKey`). The only `ON DELETE CASCADE` in the schema is
`vault_items.vault_id → vaults.id`. So `DELETE FROM users` would orphan
rows everywhere; the prune has to delete from each user-owned table
explicitly:

```sql
BEGIN;
CREATE TEMP TABLE keep ON COMMIT DROP AS
  SELECT user_id FROM users WHERE email LIKE '${EMAIL_LIKE}';
DELETE FROM api_keys             WHERE user_id NOT IN (SELECT user_id FROM keep);
DELETE FROM agent_environments   WHERE user_id NOT IN (SELECT user_id FROM keep);
DELETE FROM sessions             WHERE user_id NOT IN (SELECT user_id FROM keep);
DELETE FROM skills               WHERE user_id NOT IN (SELECT user_id FROM keep);
DELETE FROM memories             WHERE user_id NOT IN (SELECT user_id FROM keep);
DELETE FROM vaults               WHERE user_id NOT IN (SELECT user_id FROM keep);
                          -- vault_items cascades from vaults (only real FK)
DELETE FROM user_settings        WHERE user_id NOT IN (SELECT user_id FROM keep);
DELETE FROM device_authorization WHERE user_id IS NOT NULL
                                   AND user_id NOT IN (SELECT user_id FROM keep);
DELETE FROM users                WHERE email NOT LIKE '${EMAIL_LIKE}';
COMMIT;
```

Followed by a schema-drift assertion that fails loudly if any user-owned
table contains a `user_id` that isn't in `users` after the prune. Catches
future migrations that add a new user-owned table without a matching prune
DELETE.

The prune happens at snapshot creation time on the prod VM, against a
short-lived temp DB on the same PG cluster. The resulting dump file
contains only allowlisted users — the file that lives on the office server
is already minimized. Zero-trust still applies to the office server, but
the data on disk there is bounded by the allowlist, not by prod's full
user base.

## File store filtering

The seed needs to include only the file-store blobs referenced by surviving
sessions and skills (avoids carrying prod's full file store, which can be
arbitrarily large). After the prune in the temp DB, the script collects:

```sql
SELECT file_key FROM sessions WHERE file_key IS NOT NULL
UNION ALL
SELECT file_key FROM skills   WHERE file_key IS NOT NULL
```

…and rsyncs only those blobs from `/opt/clawdi-cloud/data/files/` into the
snapshot tarball.

## Encryption keys

Both `VAULT_ENCRYPTION_KEY` and `ENCRYPTION_KEY` are copied from prod's
`.env` into each preview's Coolify env-vars set. Cloned vault rows are
AES-GCM-encrypted with prod's key; a different key makes them
undecryptable, breaking realistic prototyping.

This is a deliberate posture, not an oversight: previews are *not* a
security boundary against an attacker with access to the office Coolify
host. They're a workflow boundary against accidental prod modification.

## Components

### `deploy/snapshot/dump.sh` (runs on prod VM)

```
Usage: dump.sh [--email-domain @phala.network] [--out <path>]
```

1. Validate `--email-domain` against `^@[a-z0-9.-]+$`.
2. Create a temp DB `clawdi_snapshot_temp` on the same PG cluster (drop
   if exists, then create).
3. `pg_dump -Fc -d clawdi_cloud_prod | pg_restore -d clawdi_snapshot_temp`.
4. Run the prune SQL (template in `prune.sql.tmpl`, substituted with
   `EMAIL_LIKE='%${email_domain}'`).
5. Collect surviving `file_key`s into `keys.txt`.
6. `pg_dump -Fc -d clawdi_snapshot_temp > snapshot.pg_dump`.
7. `tar -czf <out> snapshot.pg_dump <files-from filtered rsync>`.
8. Drop temp DB.

Output: a single `clawdi-snapshot-YYYY-MM-DD.tar.gz` containing
`snapshot.pg_dump` (Postgres custom-format dump) and `files/` (only the
referenced blobs).

### `deploy/snapshot/prune.sql.tmpl`

The SQL above as a template; `${EMAIL_LIKE}` substituted by `dump.sh` via
`envsubst`.

### `deploy/preview/docker-compose.yml`

Per-preview stack that Coolify builds from this repo for each
PR/branch. Three services + one init:

- **postgres** (`pgvector/pgvector:pg16`) — the per-preview DB.
- **restore** (`alpine` + `postgresql-client` + `tar`) — one-shot init
  service. Mounts the host snapshot dir read-only at `/snapshots`. On
  first boot (when `postgres` is fresh and the api container's file
  bind-mount is empty), runs `pg_restore` of `snapshot.pg_dump` and
  `tar -xf` of the files dir. Idempotent: detects "already restored"
  via a marker row in PG.
- **api** (`python:3.12-slim`) — same idempotent startup as before
  (`uv sync --frozen && alembic upgrade head && uvicorn`). No clone init
  — Coolify clones the repo into the build context.
- **web** (`oven/bun:1`) — `bun install --frozen-lockfile && bun run dev`.

The compose file declares the snapshot bind mount:
`- /var/clawdi-snapshots:/snapshots:ro`. Coolify v4 honors compose-defined
bind mounts; the operator approves the mount once per resource in the
Coolify UI.

### `deploy/preview/restore.sh`

Lives in the repo, copied into the `restore` service's image at runtime.
Idempotent: checks for a sentinel table; if absent, restores; if present,
exits 0.

### `deploy/preview/README.md`

Operator-facing doc for setting up Coolify + Cloudflare Tunnel.

## Operator setup

One-time, on the office Coolify server:

1. **Install Coolify** per upstream docs.
2. **Install `cloudflared`** as a Docker service in the same network as
   `coolify-proxy`. Cloudflare Zero Trust dashboard → Networks → Tunnels
   → Create tunnel → install via Docker. Configure ingress
   `Service: http://coolify-proxy:80` (NOT `localhost:80` — the proxy is
   the per-deploy router).
3. **Cloudflare DNS:** add `CNAME *.clawdi.ai → <tunnel-id>.cfargotunnel.com`,
   proxied. Confirm explicit one-label records (`cloud.clawdi.ai`,
   `cloud-api.clawdi.ai`, `api.clawdi.ai`, etc.) are unaffected.
4. **Cloudflare SSL/TLS:** set zone mode to **Full**.
5. **Snapshot dir:** `mkdir /var/clawdi-snapshots && chown <coolify-user> /var/clawdi-snapshots`.
6. **Coolify GitHub App / source:** connect to the Clawdi-AI/clawdi-oss
   repo. Configure preview deployments with hostname pattern
   `{{pr_id}}-preview.clawdi.ai` for web and
   `{{pr_id}}-preview-api.clawdi.ai` for api.
7. **Coolify env vars** (preview-only set, kept separate from prod):
   - From prod's `/opt/clawdi-cloud/backend/.env`: `CLERK_PEM_PUBLIC_KEY`,
     `VAULT_ENCRYPTION_KEY`, `ENCRYPTION_KEY`, `COMPOSIO_API_KEY`,
     `MEMORY_EMBEDDING_MODE`, `MEMORY_EMBEDDING_API_KEY` if any,
     `MEMORY_EMBEDDING_BASE_URL` if any, `MEMORY_EMBEDDING_MODEL`.
   - From Vercel's web env: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
     `CLERK_SECRET_KEY`.
   - Per-preview overrides Coolify substitutes per build:
     `PUBLIC_API_URL`, `WEB_ORIGIN`, `CORS_ORIGINS`, `NEXT_PUBLIC_API_URL`,
     `ENVIRONMENT=preview-{{pr_id}}`, `ALLOWED_EMAIL_DOMAINS=@phala.network`,
     `FILE_STORE_LOCAL_PATH=/data/files`, `DATABASE_URL` (compose-internal
     `postgres` host).

8. **Clerk dashboard:** add `https://*.clawdi.ai` to Allowed Origins and
   `https://*.clawdi.ai/sign-in/sso-callback` to Authorized Redirect URLs
   for the prod app. (Wildcard at the apex level — covers all current and
   future one-label subdomains, including previews.)

## Snapshot refresh workflow

```
operator: ssh clawdi
operator:   cd /opt/clawdi-cloud
operator:   ./deploy/snapshot/dump.sh --out /tmp/clawdi-snapshot-2026-04-28.tar.gz
operator: scp /tmp/clawdi-snapshot-2026-04-28.tar.gz coolify-host:/var/clawdi-snapshots/
operator: ssh coolify-host
operator:   ln -sf clawdi-snapshot-2026-04-28.tar.gz /var/clawdi-snapshots/latest.tar.gz
```

Existing previews keep their already-restored DB until they're
redeployed; new previews pick up the new snapshot. To force-refresh a
running preview, redeploy it via Coolify (drops volumes, re-runs `restore`
init).

## Failure modes

- **`dump.sh` fails mid-run** — temp DB left behind. Re-run `dump.sh`;
  it drops the temp DB at start before recreating.
- **Snapshot file missing on Coolify host** — `restore` init logs the
  error and the preview's `api` never starts. Operator scps a snapshot,
  redeploys.
- **Cloudflare Universal SSL doesn't yet cover a brand-new
  `<pr_id>-preview.clawdi.ai` hostname** (Universal SSL is *not* instant
  on first request — typically up to a few minutes after the wildcard
  CNAME is added the first time). Subsequent previews are instant.
- **`cloudflared` tunnel disconnects** — Cloudflare retries automatically;
  no operator action needed unless the auth token is rotated.
- **Coolify proxy down** — all previews unavailable until restored. Same
  failure mode as any single-host deployment.

## Testing

- **Manual end-to-end on the office server:** open a PR with a trivial
  doc-only change → Coolify auto-deploys preview → visit
  `https://<pr_id>-preview.clawdi.ai` → sign in with `@phala.network`
  Clerk account → memories visible → close PR → Coolify tears down
  preview.
- **Snapshot integrity:** `dump.sh` finishes without raising the
  schema-drift assertion. The assertion is the test for "did we remember
  to prune every user-owned table?"
- No CI for `dump.sh` itself — it's a single-shot operator script that
  exercises real prod PG. Manual run is the test.

## Deferred

- **Automated snapshot refresh** (cron on prod VM, scp via SSH key, or
  push from prod to a Coolify-hosted endpoint). v2.
- **Per-preview memory provider isolation:** if a cloned `mem0_api_key`
  in `user_settings` survives the prune, that preview will hit prod Mem0
  with the prod key. Acceptable for now (allowlisted users, internal
  team).
- **Snapshot encryption at rest** on the office host. Not done in v1
  because the host is team-only.
- **Composio connector OAuth callbacks** to preview hostnames. Existing
  cloned connections work because their OAuth tokens are already issued;
  any new connection initiated *from* a preview would 404 on the redirect
  URI. Document, defer.
