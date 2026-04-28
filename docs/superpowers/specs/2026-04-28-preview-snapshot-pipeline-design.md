# Preview Snapshot Pipeline (Coolify + Cloudflare Tunnel)

**Status:** Design
**Date:** 2026-04-28

## Problem

Production runs at `<your-prod-fqdn>`. The team experiments fast and wants
every PR / branch to get its own ephemeral preview environment that looks
like production (real-shaped data, working web + API, real DNS) so reviewers
can poke at proposed changes against realistic load without breaking
customers. Production-data freshness is not critical — a snapshot refreshed
manually now and then is enough.

Two earlier shapes were considered and discarded:

- **Operator runs a manual `fork.sh up <slug>` script on the prod VM.**
  Works, but every preview is a manual action by whoever's reviewing.
  Doesn't scale to "every PR."
- **Coolify on the prod VM with per-PR forks of the live prod DB.**
  Co-locating preview workloads on the prod box creates resource and
  blast-radius concerns we don't want.

The chosen shape: **Coolify on a separate self-hosted server, fed by
manually-refreshed snapshots of prod.**

This document uses placeholders (`<your-domain>`, `<your-team-email-domain>`,
`<owner>`/`<repo>`, `<prod-host>`, `<coolify-host>`) — substitute concrete
values from your deployment.

## Goals

- One PR / branch on GitHub → one Coolify preview at a stable hostname.
- Each preview boots from a precomputed snapshot containing *only*
  users in the configured email-domain allowlist — keeps zero-trust
  posture even though the Coolify host is on a private network.
- Snapshot refresh is operator-triggered today (just a `dump.sh` invocation
  on the prod VM, scp'd to the self-hosted Coolify host). No automation in v1.
- TLS / DNS handled by Cloudflare Tunnel + Universal SSL — no certbot,
  no inbound ports on the self-hosted server.
- Preview teardown is automatic when the PR is closed/merged.

## Non-goals

- Not auto-refreshing snapshots. Out of scope until pain shows up.
- Not multi-region, not high-availability. One Coolify host, one snapshot.
- Not isolating previews from each other at network level — they all run
  on the same trusted host with the same snapshot.
- Not a security boundary against an attacker with shell on the Coolify
  server. Snapshots reuse prod's encryption keys; the data is in
  cleartext blast radius once the host is compromised.

## Architecture

```
                            ┌──────────────────────────────────────┐
                            │  prod VM                              │
   operator runs            │                                       │
   deploy/snapshot/dump.sh ─┤   pg_dump prod → temp DB → prune     │
   on the prod VM           │   → pg_dump pruned → tar with files  │
                            │   → /tmp/clawdi-snapshot-YYYY-MM-DD.tar.gz
                            └──────────────────────────────────────┘
                                          │  scp (manual)
                                          ▼
                            ┌──────────────────────────────────────┐
                            │  self-hosted Coolify host             │
                            │                                       │
                            │  /var/clawdi-snapshots/latest.tar.gz  │
                            │                                       │
                            │  Coolify (self-hosted)                │
                            │   ├─ coolify-proxy (Traefik)          │
                            │   ├─ cloudflared (in coolify net)     │
                            │   └─ per-PR preview projects:         │
                            │      ├─ clone (alpine/git, init)      │
                            │      ├─ postgres (pgvector)           │
                            │      ├─ restore (postgres-alpine, init)
                            │      ├─ api (python:3.12-slim)        │
                            │      └─ web (oven/bun:1)              │
                            └────────────┬─────────────────────────┘
                                         │ outbound persistent conn
                                         ▼
                            ┌──────────────────────────────────────┐
                            │  Cloudflare edge (Universal SSL)      │
                            │  *.<your-domain> CNAME → tunnel-id    │
                            └──────────────────────────────────────┘
                                         ▲
                                         │ HTTPS
                                       client
```

## DNS and TLS

Universal SSL on the free Cloudflare plan covers **one label below the
apex** only. So `foo.<your-domain>` is covered, `foo.preview.<your-domain>` is
not.

To stay on the free plan and avoid Cloudflare Advanced Certificate Manager
(~$10/mo per zone), preview hostnames live one level under the apex with a
hyphen-style "namespace":

- web: `<pr_id>-preview.<your-domain>`
- api: `<pr_id>-preview-api.<your-domain>`

DNS in Cloudflare for `<your-domain>`:

- **Add:** `CNAME *.<your-domain> → <tunnel-id>.cfargotunnel.com` (proxied).
- **Verify** that any *explicit* one-label records you already have are
  unaffected — explicit records always win over wildcards.

Cloudflare SSL/TLS mode for the zone: **Full** (not Full Strict). Cloudflare
terminates TLS at the edge with the Universal SSL cert; the cloudflared
tunnel forwards HTTPS to coolify-proxy with `noTLSVerify` set so Traefik's
self-signed routes accept the upgraded connection (avoids the HTTP→HTTPS
redirect loop that breaks plain-HTTP forwarding).

## Data filter — why dump-and-prune at snapshot time

The schema has no real foreign keys on `user_id` (every user-owned table
declares `user_id` as a plain `UUID` column with `index=True` but no
`ForeignKey`). The only `ON DELETE CASCADE` in the schema is
`vault_items.vault_id → vaults.id`. So `DELETE FROM users` would orphan
rows everywhere; the prune has to delete from each user-owned table
explicitly. The prune SQL also gates each DELETE with `to_regclass(t) IS
NOT NULL` so it's tolerant of schema drift between this repo's models and
the live prod migrations.

Followed by a schema-drift assertion that fails loudly if any user-owned
table contains a `user_id` that isn't in `users` after the prune. Catches
future migrations that add a new user-owned table without a matching prune
DELETE.

The prune happens at snapshot creation time on the prod VM, against a
short-lived temp DB on the same PG cluster. The resulting dump file
contains only allowlisted users — the file that lives on the Coolify host
is already minimized.

## File store filtering

The seed includes only the file-store blobs referenced by surviving
sessions and skills (avoids carrying prod's full file store, which can be
arbitrarily large). After the prune in the temp DB, the script collects
the surviving `sessions.file_key` and `skills.file_key` values and
`rsync --files-from=keys.txt` only those blobs into the snapshot tarball.

## Encryption keys

Both `VAULT_ENCRYPTION_KEY` and `ENCRYPTION_KEY` are copied from prod's
`.env` into each preview's Coolify env-vars set. Cloned vault rows are
AES-GCM-encrypted with prod's key; a different key makes them
undecryptable, breaking realistic prototyping.

This is a deliberate posture, not an oversight: previews are *not* a
security boundary against an attacker with access to the Coolify host.
They're a workflow boundary against accidental prod modification.

## Components

### `deploy/snapshot/dump.sh` (runs on prod VM)

```
Usage: dump.sh [--email-domain @<your-team-email-domain>] [--out <path>]
```

1. Validate `--email-domain` against `^@[a-z0-9.-]+$`.
2. Create a temp DB on the same PG cluster (drop if exists, then create).
3. `pg_dump -Fc -d <prod-db> | pg_restore -d <temp-db>`.
4. Run the prune SQL (template in `prune.sql.tmpl`, substituted with
   `EMAIL_LIKE='%${email_domain}'`).
5. Collect surviving `file_key`s into `keys.txt`.
6. `pg_dump -Fc -d <temp-db> > snapshot.pg_dump`.
7. `tar -czf <out> snapshot.pg_dump <files-from filtered rsync>`.
8. Drop temp DB.

Output: a single `clawdi-snapshot-YYYY-MM-DD.tar.gz` containing
`snapshot.pg_dump` (Postgres custom-format dump) and `files/` (only the
referenced blobs).

### `deploy/snapshot/prune.sql.tmpl`

The prune SQL as a template; `${EMAIL_LIKE}` substituted by `dump.sh` via
`envsubst`.

### `deploy/preview/docker-compose.yml`

Per-preview stack that Coolify deploys for each PR/branch. Five services:

- **clone** (`alpine/git`) — one-shot init. Detects PR id from
  `COOLIFY_CONTAINER_NAME` and fetches `refs/pull/<id>/head` into the
  shared `source` named volume. Falls back to a fixed `REPO_REF` (production
  tracker) when not in a PR context.
- **postgres** (`pgvector/pgvector:pg16`) — the per-preview DB.
- **restore** (`postgres:16-alpine`) — one-shot init. Mounts the host
  snapshot dir read-only at `/snapshots`. On first boot, runs `pg_restore`
  of `snapshot.pg_dump` and `tar -xf` of the files dir. Idempotent:
  detects "already restored" via a marker row in PG.
- **api** (`python:3.12-slim`) — `uv sync --frozen && alembic upgrade head
  && uvicorn`.
- **web** (`oven/bun:1`) — `bun install --frozen-lockfile --ignore-scripts
  && bun run build && bun run start` (production build, no HMR — keeps
  Cloudflare Tunnel happy and matches prod parity).

The compose file declares the snapshot bind mount:
`- /var/clawdi-snapshots:/snapshots:ro`. Coolify v4 honors compose-defined
bind mounts; the operator approves the mount once per resource in the
Coolify UI.

URL env vars (`PUBLIC_API_URL`, `WEB_ORIGIN`, `CORS_ORIGINS`,
`NEXT_PUBLIC_API_URL`) are derived inside each container's startup command
from `SERVICE_FQDN_*` (Coolify auto-injects these per service per deploy
with the actual hostname). Compose-time `${SERVICE_FQDN_API}` substitution
would resolve from the project `.env` file, which holds the production
tracker's value — the per-PR value is only available at container runtime.

Database connectivity uses `${SERVICE_NAME_POSTGRES:-postgres}` because
Coolify renames services per-PR (`postgres` → `postgres-pr-N`) but doesn't
rewrite hardcoded DATABASE_URL hosts.

### `deploy/preview/restore.sh`

Lives in the repo, read by the `restore` service from the cloned source
volume at `/source/deploy/preview/restore.sh`. Idempotent: checks for a
sentinel table; if absent, restores; if present, exits 0.

### `deploy/preview/README.md`

Operator-facing doc for setting up Coolify + Cloudflare Tunnel.

## Operator setup highlights

Detailed steps live in `deploy/preview/README.md`. The non-obvious bits:

- **Symlink farm for snapshot bind mount.** Coolify auto-suffixes host
  bind paths with `-pr-N` per preview deploy. Pre-create symlinks
  `/var/clawdi-snapshots-pr-<N>` → `/var/clawdi-snapshots` so each preview
  finds the same shared snapshot.
- **Coolify dashboard exposed via tunnel.** GitHub webhook delivery
  requires a public URL for Coolify; expose it on a single-label hostname
  (`<dashboard-subdomain>.<your-domain>`) and update the GitHub App's
  webhook URL accordingly.
- **`preview_url_template = {{pr_id}}-{{domain}}`**. The default `{{pr_id}}.{{domain}}`
  produces two-label hostnames that Universal SSL doesn't cover.

## Snapshot refresh workflow

```
operator: ssh <prod-host>
operator:   cd /opt/<app>
operator:   ./deploy/snapshot/dump.sh \
              --email-domain @<your-team-email-domain> \
              --out /tmp/clawdi-snapshot-$(date -u +%F).tar.gz
operator: scp /tmp/clawdi-snapshot-*.tar.gz <coolify-host>:/var/clawdi-snapshots/
operator: ssh <coolify-host>
operator:   ln -sf clawdi-snapshot-<date>.tar.gz /var/clawdi-snapshots/latest.tar.gz
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
- **Cloudflare Universal SSL doesn't yet cover a brand-new preview
  hostname** (Universal SSL is *not* instant on first request — typically
  up to a few minutes after the wildcard CNAME is added the first time).
  Subsequent previews are instant.
- **`cloudflared` tunnel disconnects** — Cloudflare retries automatically;
  no operator action needed unless the auth token is rotated.
- **Coolify proxy down** — all previews unavailable until restored. Same
  failure mode as any single-host deployment.

## Testing

- **Manual end-to-end on the Coolify host:** open a PR with a trivial
  doc-only change → Coolify auto-deploys preview → visit the per-PR URL
  → sign in with an allowlisted Clerk account → memories visible → close
  PR → Coolify tears down preview.
- **Snapshot integrity:** `dump.sh` finishes without raising the
  schema-drift assertion. The assertion is the test for "did we remember
  to prune every user-owned table?"
- No CI for `dump.sh` itself — it's a single-shot operator script that
  exercises real prod PG. Manual run is the test.

## Deferred

- **Automated snapshot refresh** (cron on prod VM, scp via SSH key, or
  push from prod to a Coolify-hosted endpoint). v2.
- **Per-preview memory provider isolation:** if a cloned `mem0_api_key`
  in `user_settings` survives the prune, that preview will hit the prod
  Mem0 account. Acceptable for now (allowlisted users, internal team).
- **Snapshot encryption at rest** on the Coolify host. Not done in v1
  because the host is team-only.
- **Composio connector OAuth callbacks** to preview hostnames. Existing
  cloned connections work because their OAuth tokens are already issued;
  any new connection initiated *from* a preview would 404 on the redirect
  URI. Document, defer.
