# Preview Deployments (Coolify + Cloudflare Tunnel)

Per-PR / per-branch preview environments deployed by Coolify on the team's
office server, fronted by Cloudflare Tunnel (no public IP, no inbound ports
needed). See `docs/superpowers/specs/2026-04-28-preview-snapshot-pipeline-design.md`
for the design rationale.

## How a preview boots

1. PR opened on GitHub → Coolify webhook fires.
2. Coolify clones the repo at the PR's HEAD into the project's build dir.
3. Coolify reads `deploy/preview/docker-compose.yml` and starts the stack.
4. The `restore` service runs once: extracts `latest.tar.gz` from
   `/var/clawdi-snapshots/` into a fresh `pgdata` volume + `files` volume,
   then exits.
5. `api` starts, runs `uv sync && alembic upgrade head && uvicorn`.
6. `web` starts, runs `bun install && bun run dev`.
7. Cloudflare Tunnel routes `{{pr_id}}-preview.clawdi.ai` (web) and
   `{{pr_id}}-preview-api.clawdi.ai` (api) into Coolify's proxy.

PR closed/merged → Coolify tears the stack down, including all volumes.

## Hostname pattern

Both URLs are one label below the apex so Cloudflare's free Universal SSL
cert covers them:

- web: `{{pr_id}}-preview.clawdi.ai`
- api: `{{pr_id}}-preview-api.clawdi.ai`

Configure these patterns in Coolify per-application: **Application → General
→ Domains** for each service.

## One-time operator setup (office server)

1. **Install Coolify** per upstream docs:
   `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash`.

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
   In the tunnel's **Public Hostnames** tab, add an ingress rule:
   - Subdomain: `*`
   - Domain: `clawdi.ai`
   - Service type: `HTTP`
   - URL: `coolify-proxy:80`
     (NOT `localhost:80` — the proxy is what does per-deploy routing.)

3. **Cloudflare DNS for clawdi.ai:** add a wildcard CNAME:
   - Type: `CNAME`
   - Name: `*`
   - Target: `<tunnel-id>.cfargotunnel.com`
   - Proxy status: **Proxied** (orange cloud)

   Confirm explicit one-label records (`api.clawdi.ai`, `cloud.clawdi.ai`,
   `cloud-api.clawdi.ai`, etc.) are still present and unchanged — explicit
   records always win over the wildcard.

4. **Cloudflare SSL/TLS:** zone-level mode = **Full** (not Full Strict).
   Cloudflare terminates TLS at the edge with Universal SSL; tunnel ↔
   coolify-proxy is HTTP within the trusted Docker network.

5. **Snapshot dir:**
   ```bash
   sudo mkdir -p /var/clawdi-snapshots
   sudo chown <coolify-user> /var/clawdi-snapshots
   ```

6. **Coolify GitHub source:** Sources → New → GitHub App. Install on
   `Clawdi-AI/clawdi-oss`. Then create the application: New Resource →
   Public/Private repo → select `clawdi-oss` → Build pack: **Docker
   Compose** → compose file: `deploy/preview/docker-compose.yml`.

7. **Enable preview deployments:** in the application's settings, enable
   **Preview Deployments**, choose **Pull Request ID** as the slug source.
   Set hostname patterns:
   - web (port 3000): `{{pr_id}}-preview.clawdi.ai`
   - api (port 8000): `{{pr_id}}-preview-api.clawdi.ai`

8. **Approve the snapshot bind mount:** on first deploy, Coolify prompts
   for approval of the `/var/clawdi-snapshots:/snapshots:ro` bind mount.
   Approve once per resource.

9. **Preview environment variables** (Coolify keeps these separate from
   prod env vars). Copy from prod's `/opt/clawdi-cloud/backend/.env` on
   the prod VM:
   ```
   CLERK_PEM_PUBLIC_KEY=...
   VAULT_ENCRYPTION_KEY=...
   ENCRYPTION_KEY=...
   COMPOSIO_API_KEY=...
   MEMORY_EMBEDDING_MODE=...
   MEMORY_EMBEDDING_API_KEY=...
   MEMORY_EMBEDDING_BASE_URL=...
   MEMORY_EMBEDDING_MODEL=...
   ```
   And from Vercel's web project env:
   ```
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
   CLERK_SECRET_KEY=...
   ```
   Per-preview substitutions Coolify computes:
   ```
   PUBLIC_API_URL=https://{{pr_id}}-preview-api.clawdi.ai
   WEB_ORIGIN=https://{{pr_id}}-preview.clawdi.ai
   CORS_ORIGINS=["https://{{pr_id}}-preview.clawdi.ai"]
   NEXT_PUBLIC_API_URL=https://{{pr_id}}-preview-api.clawdi.ai
   ALLOWED_EMAIL_DOMAINS=@phala.network
   PG_PASSWORD=preview_local   # compose-internal only; not externally reachable
   ```

10. **Clerk dashboard:** add `https://*.clawdi.ai` to **Allowed Origins**
    and `https://*.clawdi.ai/sign-in/sso-callback` to **Authorized Redirect
    URLs** for the prod Clerk app.

After all ten, opening a PR on the repo deploys a preview automatically.

## Refreshing the snapshot

Snapshots are produced manually on the prod VM and scp'd to the office
server:

```bash
# On prod VM:
ssh clawdi
cd /opt/clawdi-cloud
./deploy/snapshot/dump.sh --out /tmp/clawdi-snapshot-$(date -u +%F).tar.gz

# Copy to office:
scp /tmp/clawdi-snapshot-*.tar.gz coolify-host:/var/clawdi-snapshots/

# On office Coolify host:
ssh coolify-host
cd /var/clawdi-snapshots/
ln -sf clawdi-snapshot-2026-04-28.tar.gz latest.tar.gz
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
  needs to scp a snapshot into `/var/clawdi-snapshots/latest.tar.gz` on
  the host. Once the file exists, redeploy the preview.

- **`restore` says "snapshot already loaded — skipping" but I want a fresh
  one:** redeploy the preview from Coolify. That drops the `pgdata` and
  `files` volumes; the next `restore` run sees no marker table and
  re-loads.

- **Wildcards don't route through the tunnel:** verify the tunnel's
  ingress rule points at `coolify-proxy:80`, not `localhost:80`. The proxy
  is what does per-deploy hostname dispatch. See
  https://github.com/coollabsio/coolify/discussions/2926.

- **Preview's Clerk auth fails:** check the Clerk dashboard has
  `https://*.clawdi.ai` in Allowed Origins. The wildcard at the apex
  covers all preview hostnames in one entry.
<!-- coolify preview smoke test 2026-04-28 -->
