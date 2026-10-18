---
title: "PostgreSQL backups and scheduled restore drills"
status: current
date: 2026-10-18
---

# PostgreSQL backups and scheduled restore drills

Owner-review draft. Code and hermetic tests do not certify production rollout.
The Kamal deployment configuration owns the PostgreSQL and backup accessories.
This document describes the gated host cron drill; it changes no live services.

## Execution and isolation

Root installs [host cron](../../config/postgres-drill/host-cron), following the
existing [backup cron](../../config/backup-cron) cadence. This is a host command,
not a Docker-socket-bearing accessory. The existing `postgres-backup` accessory
continues its full/differential schedule.
The runner never connects to the production database, mounts its data/socket,
uses its configuration, or invokes any pgBackRest repository write command.

Monthly on day 2, a disposable reader container uses a dedicated R2 **Object
Read only** credential (preferred; existing repo1 credentials may be used when
a read-only key is unavailable), restores a selected successful backup with standard
pgBackRest `--type=time --target-action=promote --archive-mode=off`, and prefetches
the selected timeline's WAL. The target is ten minutes before execution.
Cloud's drill runs 90 minutes after the 02:00 UTC backup. Prefetching all WAL
since that backup must stay under the 16 GiB WAL cap, and Cloud writes about
3.4 GB of WAL per hour (measured 2026-10-18). A 13:00 start fetched about 32 GiB
and failed at `restore`. The
reader starts no PostgreSQL server. Its network is used only for R2 reads.
All repository commands, including `info` and `repo-ls`, run with Docker
`--user postgres` (UID/GID 999 in the pinned image). A separate credential-free,
network-none initializer gives the empty scratch volume to postgres; it runs
only `install` as root. The fetch script rejects root execution.
A second, credential-free container uses `--network none`, a local WAL directory,
`listen_addresses=''`, no preload libraries, and `archive_mode=off`. Original
PostgreSQL configuration is replaced before starting the scratch server.
The generated configuration preserves the restored control file's
`max_connections`, `max_worker_processes`, `max_wal_senders`,
`max_prepared_transactions` and `max_locks_per_transaction`. `pg_controldata`
runs with `LC_ALL=C`; all five fields must be present and contain only integers.
These shared-memory settings must be at least the primary's recorded values
for recovery to start. No restored configuration or production files are read.

PostgreSQL must reach/promote at the target. The application query requires
nonempty users/agent environments/sessions; no counts/rows leave the container.
Application activity can be old. PITR recency is checked separately using
`pg_last_xact_replay_timestamp()`, which must be within one hour before target.
`pg_amcheck --heapallindexed --parent-check --install-missing` checks the scratch
application database, followed by clean shutdown and full `pg_checksums --check`.
amcheck does not structurally validate GIN/HNSW indexes; checksums cover pages.

Every container is limited to 2 CPUs, 2 GiB memory, 256 PIDs and I/O weight 100.
The entire run is bounded to four hours. Before restoration, repository object
sizes and uncompressed backup size are read; required scratch space includes
120% of the uncompressed backup plus the 16 GiB WAL cap. After reserving that
scratch estimate, free space on DockerRootDir's filesystem must remain at least
**25% of the filesystem total**: `available - scratch >= total / 4`. Repository
size does not add a free-space requirement; archived WAL can greatly exceed the
bounded prefetch needed by one restore. WAL prefetch enforces its cap during
download. The host-wide
`/run/lock/clawdi-postgres-drill.lock` serializes both stanzas.
A busy lock waits at most five minutes, then publishes `failed/lock_timeout`.
After acquiring it, the runner removes earlier killed-run resources matching
only its exact stanza plus the generated 12-hex suffix. These are headroom
checks, not a disk quota; concurrent unrelated disk consumption remains a risk.

Finally the runner forcibly removes its own named container and scratch volume,
including on timeout or SIGTERM. Cleanup failure is a failed result. No command
diagnostics or application data are published. A power loss/SIGKILL can bypass
cleanup; the next locked run removes that stanza's leftover scratch resources. A running status older than four hours plus
five minutes alerts. Scratch shares the DB host under the approved scope;
**off-host drills remain a later improvement**. Monitor host I/O during rollout.

## Retention and capacity

Repo1 retains **four weekly fulls**, with their differential backups and required
WAL. The prior October 17 Cloud drill measured 15.8 GB uncompressed / 3.66 GB
compressed for its latest backup. Four similarly sized fulls alone are about
14.6 GB compressed; differential/WAL history is additional. Hosted/current totals
are unverified. The runner measures the entire live repository before restoring;
root must confirm account billing/storage limits and host scratch space first.

Future: an immutable offsite copy could use `rclone copy --immutable` into a new
`<stanza>/<date>/` prefix in a separate R2 bucket, with separate credentials,
a 14-day bucket lock and a 35-day lifecycle. Dated prefixes avoid overwriting
pgBackRest's mutable `backup.info`/`archive.info`. A live repo1/repo2 must not be
bucket-locked because those metadata overwrites and normal expiry conflict with
locks. This future copy is outside the approved scope; no bucket, copy code,
configuration, credentials, or rollout is required by this change.

## Root provisioning and deployment order

The drill gate defaults off. Root owns all following production actions; leaf
agents must not execute them. Apply the equivalent Cloud instructions in the
paired Hosted PR.

1. Review both PRs, merge Cloud first and Hosted second. Follow the normal
   release runbook; merging does not install host cron. No database image pin
   changes or PostgreSQL reboots are needed.
2. Verify live DockerRootDir free space and repository sizes read-only. Outside
   active backup windows, root reboots **only** each `postgres-backup` accessory
   to install the four-full retention setting. Never reboot `postgres`/`all`.
   Archive-push does not use full-backup retention, so the running server does
   not need a restart just to adopt that retention value.
3. Install reviewed `scripts/postgres-drill/` and `config/postgres-drill/` under
   `/opt/clawdi-postgres/cloud/`, root-owned and not application-writable. Host
   prerequisites: Python >=3.10, Docker CLI/daemon and cron supporting `CRON_TZ`
   (otherwise convert the supplied UTC schedule to the host timezone). Copy
   `config.example.json` to `/etc/clawdi-postgres/cloud.json` in a root-owned
   0700 directory, initially with `enabled=false`. Pull the digest-pinned image.
4. Create the root-owned mode-0600 `cloud-readonly.env` in that directory. It
   contains only `PGBACKREST_STANZA`, repo1 S3 type/path/bucket, endpoint/region/
   URI-style, key/secret and cipher type/pass. Match the nonsecret repository
   shape in `config/deploy.yml`, without PG1 paths or sockets. Prefer a separate
   R2 **Object Read only**, bucket-scoped key. If unavailable, root may use the
   existing repo1 credential in this separate file; the runner's only pgBackRest
   commands are `info`, `repo-ls`, `restore` and `archive-get`. IAM then does not
   enforce read-only access, so keep the runner/config root-owned and review its
   digest/source. Never print credentials or reuse the production config/data
   mount. No new bucket or Cloudflare rule is needed.
5. Set `enabled=true`, and run the root host command once for each stanza:

   ```bash
   /usr/bin/python3 /opt/clawdi-postgres/cloud/scripts/postgres-drill/run.py /etc/clawdi-postgres/cloud.json
   ```

   Require `clawdi.drill.json` (Hosted: `clawdi-hosted.drill.json`) mode 0644,
   schema 1, success, sensible RTO/RPO and no scratch containers/volumes. Install
   the provided root [host cron](../../config/postgres-drill/host-cron), with
   staggered Hosted/Cloud hours. Do not mount the Docker socket into an accessory.
   Keep the existing status parent mounted read-only in Hosted BULK.
6. Once **both** stanzas pass, root enables `FLEET_HEALTH_DB_DRILL_ENABLED=true`
   in the paired Hosted release through that repository's release runbook.
   Existing DB-status monitoring must remain enabled. Verify two five-minute
   fleet-health rounds, API health and no host resource regressions.

The monitor reads atomic drill files independently of SQL/feed health. Missing,
invalid, failed and >35-day-old runs alert through the existing Discord/Sentry
path. A failed result is not hidden by an earlier success. Check failures retain
schema 1 and publish only a fixed phase: `checks_start` (server startup),
`checks_promote` (promotion/query or bounded wait), `checks_sanity` (nonempty core
tables), `checks_replay` (replay timestamp window), `checks_amcheck` (structural
checks), or `checks_checksums` (clean shutdown/offline checksums). The check
container uses reserved exit codes 71–76 for these phases; the runner discards
stdout/stderr diagnostics. All phases still alert as failed. Inspect only the
status metadata; never publish scratch logs or application data.

Rollback: disable the alert flag through the release path, disable host cron/config and remove only
this task's interrupted scratch resources. Retention can remain at four fulls.

Done: both stanzas pass PITR/application/amcheck/checksum gates, record RTO/RPO,
leave empty scratch resources and stay healthy across two alert rounds. Until
that owner-recorded gate, production execution and alert delivery are unverified.

## Hermetic verification

Run `bash scripts/test.sh postgres-drill`. Docker Compose creates a tiny
checksummed PostgreSQL database and local pgBackRest repository, commits on both
sides of an explicit PITR target, restores, and verifies that the post-target
row is excluded. The source uses 200 connections and raises all five
recovery-sensitive settings above their defaults. Lowering the restored
connection limit to 100 must fail startup; using the control-file settings must
pass. Missing/noninteger control fields must fail before recovery. Capacity
tests cover the exact 25% boundary with a repository larger than free disk.
A separate credential-free/network-none container runs integrity checks. The actual product sanity SQL must pass with application timestamps
from 2000 while recent WAL reaches the target. Each of the six check steps is
fault-injected against a fresh restore and must return its reserved code; the
runner tests verify failed status/cleanup without diagnostic leaks, and Hosted
monitor tests verify every phase still alerts. A fresh restore with removed WAL
must also fail. Shellcheck, Python lint and safety/status tests run in
containers too. The fixture keeps the production
image's default root user and reproduces pgBackRest's root refusal. The driver
then executes the runner's actual Docker commands for metadata, scratch setup,
restore/WAL fetch and checks, without substituting a test-only image user. The
checkout is mounted read-only and all test resources are removed. Hosted also
tests metadata consumption, failure/staleness alerts and feed-outage independence
through its hermetic backend
runner. Real R2 access, host cron, resource limits and alert delivery require the
root rollout gate.

## References

- [PostgreSQL recovery shared-memory settings](https://www.postgresql.org/docs/18/hot-standby.html#HOT-STANDBY-ADMIN)
- [pgBackRest restore options](https://pgbackrest.org/command.html#command-restore)
- [pgBackRest retention](https://pgbackrest.org/configuration.html#section-repository)
- [R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)
