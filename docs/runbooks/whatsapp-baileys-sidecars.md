# WhatsApp Baileys sidecar operations

Clawdi deploys one business-neutral Baileys provider service. The service owns
many isolated physical sessions but has no tenant, Shared/Custom, inventory,
Agent Link, or chat Pair knowledge.

```text
backend / channels-worker
  -> /run/clawdi-whatsapp/sidecar.sock
  -> whatsapp-baileys Kamal accessory
       -> /data/<provider-session-id>/provider-state.sqlite
```

PostgreSQL maps each `ChannelAccount` or active onboarding reservation to an
opaque provider session UUID. Each provider session owns exactly one Baileys
`WASocket`, auth state, Signal state, retry store, and durable provider inbox.

## Deployment contract

Kamal declares one fixed `whatsapp-baileys` accessory in `config/deploy.yml`:

- state: `/home/phala/clawdi-whatsapp/state` -> `/data`, mode `0700`;
- run: `/home/phala/clawdi-whatsapp/run` -> `/run/clawdi-whatsapp`, mode `0770`;
- socket: `/run/clawdi-whatsapp/sidecar.sock`, mode `0660`;
- app mount: the run directory only, read-only;
- root filesystem: read-only, all capabilities dropped, no new privileges;
- network: Docker bridge for provider egress, with no published port;
- identity: numeric UID/GID `1000:1000` for the Kamal SSH user, backend, and sidecar.

The only sidecar deployment secret is
`CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN`, one high-entropy service bearer used
between backend processes and the singleton. Account/session UUIDs are not
deployment configuration. Do not add per-account secrets, accessories,
host-root variables, or JSON registries.

## Storage gate

Before scanning the first QR, verify the fixed state root is persistent local
block storage encrypted at rest. SQLite WAL does not support network
filesystems, so NFS, SMB, FUSE, object-store mounts, and shared filesystems are
out of contract.

```bash
kamal server exec \
  "findmnt -T /home/phala/clawdi-whatsapp/state && \
   test \"\$(id -u)\" = 1000 && test \"\$(id -g)\" = 1000 && \
   test \"\$(realpath -e /home/phala/clawdi-whatsapp/state)\" = /home/phala/clawdi-whatsapp/state && \
   test \"\$(stat -c '%u:%g:%a' /home/phala/clawdi-whatsapp/state)\" = 1000:1000:700 && \
   test \"\$(realpath -e /home/phala/clawdi-whatsapp/run)\" = /home/phala/clawdi-whatsapp/run && \
   test \"\$(stat -c '%u:%g:%a' /home/phala/clawdi-whatsapp/run)\" = 1000:1000:770"
```

Treat volume snapshots and backups as WhatsApp credentials. Encrypt backups,
restrict them to the operator identity, and test restore on an isolated host.

Done: the storage-gate command exits 0 and reports the exact fixed state and
run directories.

## Release order

Kamal 2.12 reboots the exact singleton, verifies its full-SHA image, and
requires its authenticated UDS healthcheck. Only then does the workflow deploy
the new backend and channels worker. The singleton uses the clean fixed
`/home/phala/clawdi-whatsapp/state` root and stores each session directly at
`/data/<provider-session-id>`.

Done: the release job exits 0 only after the exact singleton image and
authenticated healthcheck pass, then starts `kamal deploy` for the backend.

## Rollback boundary

Keep the singleton protocol and fixed state root across rollback revisions.
Once a session is paired, its directory is the sole durable credential
authority; never boot another physical owner or restore credentials into a
second service.

## Session lifecycle limitation

Cancel and confirmed logout stop the physical socket and clear registration,
so a terminal unregistered session is not a physical owner. Its runtime and
SQLite handle currently remain loaded until singleton shutdown. Explicit
in-process eviction is intentionally deferred for the current pilot: a safe
implementation needs request leasing or equivalent serialization so a
concurrent session request cannot reopen the same SQLite database while the old
runtime is closing. Adding a naive unload endpoint would weaken the one-owner
guarantee. Monitor loaded session count; all runtimes close during graceful
singleton shutdown.

## Recovery and retirement

The sidecar does not scan the state root or infer product ownership. PostgreSQL
identifies active reservations and accounts; session-scoped requests lazily
open their state. An unreferenced directory stays inert.

For a paired product account, retirement remains explicit:

1. use backend archive/delete so physical logout is confirmed;
2. verify the account is archived and ingress is stopped;
3. back up the exact session directory if retention policy requires it;
4. remove only that exact UUID directory during a separate approved operator
   maintenance action.

Never automatically prune unknown directories during deploy.

## Monitoring

Monitor the accessory health and restart count, active session count,
per-session connection state, provider inbox depth, ingress pump errors, disk
space, SQLite integrity failures, and backup age. Keep the UDS mount
backend-only, rotate the singleton bearer deliberately, and never log it.
