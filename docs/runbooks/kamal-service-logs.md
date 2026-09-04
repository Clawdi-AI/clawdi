# Kamal Service Logs

Use this runbook for host-local operational logs from the production Kamal
deployment. It covers the `web`, `embedding-worker`, and `channels-worker` app
roles and the `whatsapp-baileys`, `postgres`, and `postgres-backup` accessories.
The shared `kamal-proxy` deliberately does not persist container logs. This
does not change self-hosted Compose deployments, tenant runtimes, or any guest
journal configuration.

## Design

`config/deploy.yml` selects Docker's `journald` logging driver. Docker sends a
container's stdout and stderr to the host journal, where the entries remain
available after Kamal removes the container. `docker logs` remains available
for a current container, and `journalctl` can select current or removed
containers by `CONTAINER_NAME`.

Kamal 2.12 applies root [`logging`](https://github.com/basecamp/kamal/blob/v2.12.0/lib/kamal/configuration/docs/logging.yml)
to app roles and uses the same root arguments when it starts
[`accessories`](https://github.com/basecamp/kamal/blob/v2.12.0/lib/kamal/commands/accessory.rb#L13-L30).
The proxy has a separate
[`run`](https://github.com/basecamp/kamal/blob/v2.12.0/lib/kamal/configuration/proxy/run.rb#L48-L102)
configuration. Kamal-proxy v0.9.2's
[`LoggingMiddleware`](https://github.com/basecamp/kamal-proxy/blob/v0.9.2/internal/server/logging_middleware.go)
unconditionally logs the raw request path and query at INFO, while its
[`run` command](https://github.com/basecamp/kamal-proxy/blob/v0.9.2/internal/cmd/run.go)
has no access-log disable or path-redaction option. Telegram-compatible routes
carry the provider credential in the path, so `config/deploy.yml` uses Docker's
official [`none` logging driver](https://docs.docker.com/engine/logging/configure/#supported-logging-drivers)
for the proxy. This discards its stdout and stderr before persistence instead of
trying to scrub credentials after they have reached the journal.

The host journal is the only log store for apps and accessories. Proxy
request/operational logs are unavailable; use application timing/error logs and
external health metrics for service diagnosis. Do not add a second application
log database or mount log files into service data volumes.

## Host prerequisite

Complete this once on every Kamal host before recreating any container with the
new deployment configuration. The limits below apply to the entire host system
journal, not separately to Clawdi. The journal retains at most 30 days and aims
to stay within 2 GiB while leaving 5 GiB free; the effective history can be
shorter under pressure.

```bash
sudo install -d -m 0755 /etc/systemd/journald.conf.d
sudo install -d -m 2755 -o root -g systemd-journal /var/log/journal
sudoedit /etc/systemd/journald.conf.d/60-clawdi-kamal.conf
```

Write exactly this non-secret drop-in:

```ini
[Journal]
Storage=persistent
SystemMaxUse=2G
SystemKeepFree=5G
MaxRetentionSec=30day
```

Apply and verify it without reading application log payloads:

```bash
sudo systemctl restart systemd-journald
sudo journalctl --flush
sudo systemctl is-active systemd-journald
sudo systemd-analyze cat-config systemd/journald.conf
sudo journalctl --disk-usage
test -d /var/log/journal
```

`Storage=persistent`, `SystemMaxUse`, `SystemKeepFree`, and `MaxRetentionSec`
are systemd-journald controls; see the upstream
[`journald.conf`](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)
reference. Do not continue if the effective configuration does not show all
four values or the journal service is unhealthy.

## Rollout

Logging drivers are fixed when Docker creates a container. A normal app deploy
recreates the three app roles, but it does not recreate accessories or the proxy.
After the host prerequisite is verified:

1. Deploy the app through the normal release path.
2. Reboot `whatsapp-baileys` and `postgres-backup` individually.
3. Reboot `postgres` only in an approved maintenance window; its data volume is
   unchanged, but the database is unavailable while the container restarts.
4. Reboot the shared proxy once, after every Kamal deployment that can manage it
   has the same `none` logging-driver configuration.

Do not use this rollout to enable PostgreSQL statement logging, application
debug logging, or provider protocol dumps. No data or auth volume needs to be
removed or recreated.

## Verification and access

Confirm app and accessory containers report `journald`:

```bash
docker ps --format '{{.Names}}' \
  | grep -E '^clawdi-(web|embedding-worker|channels-worker)-|^clawdi-(whatsapp-baileys|postgres|postgres-backup)$' \
  | while read -r container; do
      docker inspect --format '{{.Name}} {{.HostConfig.LogConfig.Type}}' "$container"
    done
```

Expected: all three app roles and all three accessories print `journald`.
Confirm the proxy reports `none`:

```bash
docker inspect --format '{{.Name}} {{.HostConfig.LogConfig.Type}}' kamal-proxy
```

Use an exact app or accessory container name to retrieve a bounded window:

```bash
sudo journalctl --since '1 hour ago' --lines 200 CONTAINER_NAME='<container-name>'
```

After a later deploy removes an old app container, repeat the query with its old
exact name. Seeing its pre-removal entries proves that retention is outside the
Docker container lifecycle. `docker logs kamal-proxy` is intentionally
unavailable while its logging driver is `none`.

Journal access stays restricted to approved operators. Never paste or export
raw logs without review. Logs must not contain secrets, QR or pairing values,
phone numbers or JIDs, message bodies, auth/Signal state, request bodies, or
provider protocol objects. If any appear, treat that as a logging defect and a
possible credential/privacy incident; fix the emitting service and rotate
affected credentials before sharing evidence.

After first applying the proxy logging change, treat any previously retained
Telegram credential paths as an incident: rotate affected bot tokens and use the
approved host-log remediation process. Do not inspect, copy, or export raw proxy
history merely to enumerate credentials.

Docker's official [`journald` driver](https://docs.docker.com/engine/logging/drivers/journald/)
reference documents the `CONTAINER_NAME` field and continued `docker logs`
support.
