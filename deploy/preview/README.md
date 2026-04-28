# Preview Deployments (Coolify + Cloudflare Tunnel)

Per-PR / per-branch preview environments deployed by Coolify on a self-hosted
server, fronted by Cloudflare Tunnel (no public IP, no inbound ports needed).

This file uses placeholders (`<your-domain>`, `<your-team-email-domain>`,
`<your-tunnel-id>`, `<dashboard-subdomain>`, `<owner>`/`<repo>`,
`<production-tracking-branch>`, `<prod-host>`, `<coolify-host>`) — substitute
your own values when applying.

## How a preview boots

1. PR opened on GitHub → Coolify webhook fires.
2. Coolify clones the repo at the PR's HEAD into the project's build dir.
3. Coolify reads `deploy/preview/docker-compose.yml` and starts the stack.
4. The `restore` service runs once: extracts `latest.tar.gz` from
   `/var/clawdi-snapshots/` into a fresh `pgdata` volume + `files` volume,
   then exits.
5. `api` starts, runs `uv sync && alembic upgrade head && uvicorn`.
6. `web` starts, runs `bun install && bun run build && bun run start`.
7. Cloudflare Tunnel routes `<pr_id>-preview.<your-domain>` (web) and
   `<pr_id>-preview-api.<your-domain>` (api) into Coolify's proxy.

PR closed/merged → Coolify tears the stack down, including all volumes.

## Hostname pattern

Both URLs are one label below the apex so Cloudflare's free Universal SSL
covers them under the wildcard `*.<your-domain>`:

- web: `<pr_id>-preview.<your-domain>`
- api: `<pr_id>-preview-api.<your-domain>`

Configure these patterns in Coolify per-application: **Application → Domains**
for each service.

## One-time operator setup (self-hosted server)

1. **Install Coolify** per upstream docs:
   `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash`.
   If your server's LAN already uses any 10.x.x.x subnets (e.g. WireGuard),
   pass `DOCKER_ADDRESS_POOL_BASE=172.20.0.0/14 DOCKER_ADDRESS_POOL_SIZE=24`
   to the installer to keep Docker out of that range.

2. **Install `cloudflared`** as a Docker service. In Cloudflare Zero Trust
   dashboard: **Networks → Tunnels → Create tunnel**. Copy the install
   command for Docker. Run it on the Coolify host, joining the same Docker
   network as Coolify (typically `coolify`):
   ```bash
   docker run -d --name cloudflared \
     --restart unless-stopped \
     --network coolify \
     cloudflare/cloudflared:latest tunnel --no-autoupdate run --token <token>
   ```
   In the tunnel's **Public Hostnames** tab, add ingress rules in this
   order (more-specific first):
   - `<dashboard-subdomain>.<your-domain>` → `http://coolify:8080`
     (Coolify dashboard, exposed for GitHub webhook delivery)
   - `*.<your-domain>` → `https://coolify-proxy:443` (with **No TLS Verify**)
     (catch-all → Coolify's Traefik for per-deploy routing; HTTPS to skip
     Coolify's HTTP→HTTPS redirect loop)

3. **Cloudflare DNS for `<your-domain>`:** add a wildcard CNAME:
   - Type: `CNAME`
   - Name: `*`
   - Target: `<your-tunnel-id>.cfargotunnel.com`
   - Proxy status: **Proxied** (orange cloud)

   Confirm any explicit one-label records you have are still present and
   unchanged — explicit records always win over the wildcard.

4. **Cloudflare SSL/TLS:** zone-level mode = **Full** (not Full Strict).
   Cloudflare terminates TLS at the edge with Universal SSL.

5. **Snapshot dir:**
   ```bash
   sudo mkdir -p /var/clawdi-snapshots
   sudo chown <coolify-user> /var/clawdi-snapshots
   ```
   Coolify auto-suffixes host bind paths with `-pr-<N>` per preview deploy
   (e.g. `/var/clawdi-snapshots-pr-57`). Pre-create symlinks so each
   preview can find the same shared snapshot:
   ```bash
   sudo bash -c "for n in \$(seq 1 1000); do
     ln -sfT /var/clawdi-snapshots /var/clawdi-snapshots-pr-\$n
   done"
   ```
   Add to `/etc/cron.hourly/` so future PRs > 1000 also work.

6. **Coolify GitHub source:** Sources → New → GitHub App. Install on the
   target repo. Then create the application: New Resource → repo →
   Build pack: **Docker Compose** → compose file:
   `deploy/preview/docker-compose.yml`. Ports: `3000,8000`.

7. **Configure preview deployments:**
   - Set the application's `docker_compose_domains` (Coolify UI: Domains tab):
     - web: `http://preview.<your-domain>`
     - api: `http://preview-api.<your-domain>`
   - Set the application's `preview_url_template` to `{{pr_id}}-{{domain}}`
     (single-line field in the Coolify UI).
   - Enable preview deploys (Settings → Preview Deployments → on).

8. **Approve the snapshot bind mount:** on first deploy, Coolify prompts
   for approval of the `/var/clawdi-snapshots:/snapshots:ro` bind mount.
   Approve once per resource.

9. **Configure Coolify's `APP_URL`** to its public hostname so the
   GitHub App's webhook URL is reachable from github.com:
   ```bash
   echo "APP_URL=https://<dashboard-subdomain>.<your-domain>" | \
     sudo tee -a /data/coolify/source/.env
   cd /data/coolify/source && \
     sudo docker compose --env-file .env -f docker-compose.yml \
       -f docker-compose.prod.yml up -d coolify --force-recreate
   ```
   Then in github.com → Apps → your-app → General → Webhook URL: set to
   `https://<dashboard-subdomain>.<your-domain>/webhooks/source/github/events`.

10. **Preview environment variables** (Coolify UI → Application → Environment
    Variables → check "Preview deploys" so they apply to PR builds). Copy
    secrets from your production environment:
    ```
    CLERK_PEM_PUBLIC_KEY=...
    VAULT_ENCRYPTION_KEY=...
    ENCRYPTION_KEY=...
    COMPOSIO_API_KEY=...
    MEMORY_EMBEDDING_MODE=...
    MEMORY_EMBEDDING_MODEL=...
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
    CLERK_SECRET_KEY=...
    NEXT_PUBLIC_DEPLOY_API_URL=https://<your-public-prod-api>
    NEXT_PUBLIC_CLAWDI_HOSTED=true
    ALLOWED_EMAIL_DOMAINS=<your-team-email-domain>
    REPO_URL=https://github.com/<owner>/<repo>
    REPO_REF=<production-tracking-branch>
    PG_PASSWORD=preview_local
    ```
    Per-deploy URL env vars (`PUBLIC_API_URL`, `WEB_ORIGIN`, `CORS_ORIGINS`,
    `NEXT_PUBLIC_API_URL`) are derived inside each container's startup
    command from the auto-injected `SERVICE_FQDN_*` — no need to set them
    in the Coolify UI.

11. **Clerk dashboard:** add `https://*.<your-domain>` to **Allowed Origins**
    and `https://*.<your-domain>/sign-in/sso-callback` to **Authorized Redirect
    URLs** for the production Clerk app. (Wildcard at the apex covers all
    one-label preview hostnames.)

After all eleven, opening a PR on the repo deploys a preview automatically.

## Refreshing the snapshot

Snapshots are produced manually on the production VM and scp'd to the
self-hosted Coolify server:

```bash
# On production VM:
ssh <prod-host>
cd /opt/<app>
./deploy/snapshot/dump.sh \
  --email-domain @<your-team-email-domain> \
  --out /tmp/clawdi-snapshot-$(date -u +%F).tar.gz

# Copy to self-hosted server:
scp /tmp/clawdi-snapshot-*.tar.gz <coolify-host>:/var/clawdi-snapshots/

# On the Coolify host:
ssh <coolify-host>
cd /var/clawdi-snapshots/
ln -sf clawdi-snapshot-<date>.tar.gz latest.tar.gz
```

Existing previews keep their already-restored DB until they're redeployed
(the `restore` service is idempotent via a marker table). New previews
pick up the new snapshot. To force-refresh a running preview, redeploy it
in Coolify — that drops volumes and re-runs `restore`.

## Troubleshooting

- **Preview returns Cloudflare TLS error on first request after a brand-new
  hostname:** Universal SSL is not always instant for never-before-seen
  hostnames; Cloudflare provisions on first hit, can take up to a few
  minutes. Subsequent previews are instant.

- **`restore` service fails with "snapshot not found":** the operator
  needs to scp a snapshot into `/var/clawdi-snapshots/latest.tar.gz` AND
  the symlink farm `/var/clawdi-snapshots-pr-<N>` must exist (operator
  setup step 5).

- **`restore` says "snapshot already loaded — skipping" but I want a fresh
  one:** redeploy the preview from Coolify. That drops the `pgdata` and
  `files` volumes; the next `restore` run sees no marker table and
  re-loads.

- **Wildcards 404 through the tunnel:** the tunnel's catch-all ingress
  rule must point at `coolify-proxy` (port 80 or 443), NOT `localhost`.
  The proxy is what does per-deploy hostname dispatch. See
  https://github.com/coollabsio/coolify/discussions/2926.

- **Preview's Clerk auth fails:** check the Clerk dashboard has
  `https://*.<your-domain>` in Allowed Origins.

- **Browser network tab shows requests to literal `{{pr_id}}` hostnames:**
  Coolify only substitutes `{{pr_id}}` in URL-template fields, NOT in env
  var values. This compose builds URLs from `SERVICE_FQDN_*` (Coolify
  auto-injects per-deploy values) inside each service's startup command,
  so don't set `NEXT_PUBLIC_API_URL`/`PUBLIC_API_URL` in the Coolify UI
  with `{{pr_id}}` — they'd be ignored anyway since the compose `command`
  exports the right value at runtime.
