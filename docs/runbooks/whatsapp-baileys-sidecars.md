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

## One-time account-sidecar cutover

The release workflow runs
`scripts/cutover-whatsapp-sidecar-containers.ts` through `kamal server exec`
before it boots the singleton. The remote script:

1. read-only lists every Docker container by full immutable ID;
2. reads only its exact container name and `service` label;
3. accepts the singleton only as the exact pair
   `clawdi-whatsapp-baileys` / `clawdi-whatsapp-baileys`;
4. accepts a legacy container only when both identities exactly equal
   `clawdi-whatsapp-baileys-<canonical-compact-uuid>`;
5. rejects malformed, mismatched, duplicate, or otherwise unexpected Clawdi
   WhatsApp identities before stopping anything;
6. gracefully stops each validated legacy ID with a 30-second timeout, removes
   only that exact container, then performs the same read-only scan again and
   requires zero legacy containers;
7. validates that the retired pilot root is the real, non-symlink directory
   `/home/phala/clawdi-whatsapp-sidecars`, removes that exact root, and verifies
   it is absent.

The retired account-scoped pilot was never paired, so there is intentionally no
state copy or migration. The script removes its one fixed host root only after
all validated legacy containers are gone. It never removes a Docker volume and
never targets the singleton's clean `/home/phala/clawdi-whatsapp/state` root,
where each new session is stored directly at `/data/<provider-session-id>`.

After the cutover scan succeeds, Kamal 2.12 reboots the exact singleton,
verifies its full-SHA image, and requires its authenticated UDS healthcheck.
Only then does the workflow deploy the new backend and channels worker. A
failure before backend deploy leaves no legacy physical owner; it never boots
old and new account owners together. On repeat releases, zero legacy
containers and one exact singleton are normal.

Done: the release job exits 0 only after the exact singleton image and
authenticated healthcheck pass, then starts `kamal deploy` for the backend.

## Rollback boundary

The release permanently retires the unused account-scoped pilot containers and
state root before booting the singleton. Do not roll back to that topology or
recreate its directories. If the singleton or backend deployment fails, fix
forward or deploy a backend revision that retains the singleton protocol and
fixed state root. Never boot a legacy container while the singleton exists.

## Post-success repository cleanup

The same post-success review may delete these obsolete repository settings:

```bash
gh secret delete CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON --repo Clawdi-AI/clawdi
gh variable delete WHATSAPP_BAILEYS_HOST_ROOT --repo Clawdi-AI/clawdi
```

Deleting them is an operator follow-up, not part of this PR or release
workflow. Never print their prior values.

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
