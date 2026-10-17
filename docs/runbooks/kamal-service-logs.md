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

The limits below apply to the entire host system journal, including Cloud and
Hosted containers. On `clawdi`, the owner verified a 500 GB root filesystem with
386 GB free at 5:58 AM PDT on 2026-10-17. The journal used 2.9 GB and retained
only about 1.7 days: the default `SystemMaxFiles=100` was reached before the
existing 10 GB size cap.

At approximately 1.7 GB/day, 30 days needs about 51 GB. Use a 60 GiB size cap,
retain the existing 20 GiB free-space reserve, and raise the file limit to 1,000.
Growing from 2.9 GB to the full cap would leave over 300 GB free with other disk
usage unchanged. These limits target 30 days at the observed volume; increased
log volume, file rotation, or disk pressure can still shorten retention.
`MaxRetentionSec=30day` is a maximum age, not a minimum retention guarantee.

An approved operator applies the following idempotent commands on the Kamal
host. Check current disk headroom and the existing configuration first; reassess
the budget if the host no longer has the headroom above. The drop-in changes only
the five settings shown, leaving other settings to the host configuration and
defaults.

```bash
df -h /var/log
sudo journalctl --disk-usage
sudo systemd-analyze cat-config systemd/journald.conf

sudo install -d -m 0755 /etc/systemd/journald.conf.d
sudo install -d -m 2755 -o root -g systemd-journal /var/log/journal
sudo tee /etc/systemd/journald.conf.d/60-clawdi-kamal.conf >/dev/null <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=60G
SystemKeepFree=20G
SystemMaxFiles=1000
MaxRetentionSec=30day
EOF

sudo chmod 0644 /etc/systemd/journald.conf.d/60-clawdi-kamal.conf
sudo chown root:root /etc/systemd/journald.conf.d/60-clawdi-kamal.conf
sudo systemd-analyze cat-config systemd/journald.conf
```

Before restarting, inspect the merged configuration: the five values above must
be the last assignments for their keys in `[Journal]`; later drop-ins override
earlier ones. Then apply and verify without reading application log payloads:

```bash
sudo systemctl restart systemd-journald
sudo journalctl --flush
sudo systemctl is-active systemd-journald
sudo systemd-analyze cat-config systemd/journald.conf
sudo journalctl --disk-usage
df -h /var/log/journal
test -d /var/log/journal
```

Done: `systemctl is-active systemd-journald` prints `active`, the merged
configuration has all five intended values without later overrides, and disk
headroom still supports the budget. A retention-only update takes effect after
the journald restart; container recreation below is needed only when changing
Docker logging drivers.

Record the oldest retained entry's timestamp and age immediately after applying,
then repeat daily. This reads one entry's metadata without its message:

```bash
set -o pipefail
sudo journalctl --quiet --no-pager --lines=+1 --output=json \
  --output-fields=__REALTIME_TIMESTAMP \
  | python3 -c '
import json
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

entry = json.load(sys.stdin)
oldest = datetime.fromtimestamp(
    int(entry["__REALTIME_TIMESTAMP"]) / 1_000_000,
    tz=ZoneInfo("America/Los_Angeles"),
)
age_days = (datetime.now(oldest.tzinfo) - oldest).total_seconds() / 86400
print(f"Oldest entry: {oldest:%Y-%m-%d %I:%M:%S %p %Z}; age: {age_days:.2f} days")
'
```

Done: the oldest entry's age grows beyond the previous approximately 1.7-day
window and approaches 30 days over the following month. Previously deleted logs
cannot be recovered by raising the limits. If age stalls early, inspect journal
disk usage, free space, file count (`sudo find /var/log/journal -type f \(
-name '*.journal' -o -name '*.journal~' \) | wc -l`), and configuration overrides
before changing the budget again.

These are systemd-journald controls; see the upstream
[`journald.conf`](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)
and [`journalctl`](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html)
references.

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
