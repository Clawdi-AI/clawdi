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
- network: Docker bridge by default; when optional Tailscale egress is enabled,
  Baileys joins a pod-style network namespace guarded at the kernel OUTPUT
  boundary; neither configuration publishes a host port;
- restart policy: Kamal 2.12's `unless-stopped`, so an ordinary host reboot
  starts the same singleton against the same durable state root;
- identity: numeric UID/GID `1000:1000` for the Kamal SSH user, backend, and sidecar.

The only sidecar deployment secret is
`CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN`, one high-entropy service bearer used
between backend processes and the singleton. Account/session UUIDs are not
deployment configuration. Do not add per-account secrets, accessories,
host-root variables, or JSON registries.

### Mount policy

Kamal 2.12 `directories` are deliberate Docker bind mounts: Kamal creates the
host directory, applies its configured mode, and then emits `--volume` for the
container. Use Docker named volumes only for replaceable caches such as
`clawdi-fastembed`. Keep credential state and the Unix socket on narrow,
explicit host paths because operators must be able to validate ownership,
snapshot local block storage, restore one physical authority, and share the
socket with backend roles. Raw `volumes` entries are limited to read-only
consumers of an existing directory or generated file; writable accessory paths
use `directories` so creation and modes remain under Kamal control.

The deployment gate rejects symlinked or redirected paths and requires exact
UID, GID, and modes for Baileys state (`0700`), the socket directory (`0770`),
Tailscale identity (`0700`), and the guard directory (`0700`). The generated
resolver is atomically replaced as a regular `0600` file. The guard publishes
its `0644` marker atomically inside a non-world-traversable directory, and
Baileys receives that directory read-only. Do not replace these mounts with a
host root, Docker socket, network filesystem, or an automatically pruned
volume.

The kernel-networking containers keep a read-only root filesystem and bounded
`/tmp` and `/run` tmpfs mounts; `/run` carries the iptables lock files. After
dropping all default capabilities, they retain `DAC_OVERRIDE` only so their
root process can access the two Kamal-created `0700` bind mounts, plus the
network capabilities required for TUN and firewall setup.

## Optional Tailscale exit-node egress

The checked-in configuration is inert by default. Merging it does not create a
Tailscale container or change Baileys networking. Enable it only after all of
the following are provisioned in the release environment:

- repository variable `WHATSAPP_TAILSCALE_EGRESS_ENABLED=true` (the exact
  lowercase value is the activation switch);
- repository variable `WHATSAPP_TAILSCALE_EXIT_NODE`, set to the stable
  Tailscale DNS name or IP of an approved exit node;
- repository secret `WHATSAPP_TAILSCALE_AUTHKEY`, set to a tagged, one-off,
  pre-authorized, non-ephemeral key whose ACL grants only the required tailnet
  access. Persistent state keeps the node identity after bootstrap; if that
  state is ever lost, issue a new one-off key instead of making this key
  reusable.

The official Kubernetes `pause` 3.10.2 image, pinned by its immutable manifest
digest, owns a stable network namespace. Kernel-mode Tailscale, an egress guard,
and Baileys join it with Docker's `container:clawdi-whatsapp-netns` network
mode. Tailscale uses the official v1.102.2 image pinned by immutable digest,
`/dev/net/tun`, and only `NET_ADMIN` plus `NET_RAW` (required by the image's
iptables-legacy control socket after dropping Docker's default capabilities).
Its identity persists under `/home/phala/clawdi-whatsapp/tailscale-state`.
Its disposable container layer remains writable because Tailscale's Linux
direct DNS manager updates `/etc/resolv.conf` and stores its backup in `/etc`;
the persistent state and guard mounts keep their narrower permissions.
The exit-node argument explicitly disables LAN access.
`TS_AUTH_ONCE=true` makes the auth key a bootstrap credential: subsequent
container replacements reuse the persisted node identity instead of requiring
the key to remain valid.

The deploy helper requires Docker's standard `kamal` underlay network to report
`EnableIPv6=false` before it stops or replaces Baileys. The guard therefore
installs one IPv4 OUTPUT chain matching only numeric UID 1000, covering every
possible direct underlay route. That UID may use `tailscale0` and the exact local
loopback address; every other interface is rejected. Tailscaled runs as root, so
its underlay remains able to reach the Tailscale control plane and DERP.
Tailscale still provides both IPv4 and IPv6 on `tailscale0`; the Docker-facing
`eth0` has no IPv6 address or route. If `tailscale0` or its routes disappear,
IPv4 bridge fallback is rejected and no IPv6 underlay exists. Baileys uses
`100.100.100.100` through a read-only resolver file, so Docker's `127.0.0.11`
underlay DNS is not an escape path.
`TS_ACCEPT_DNS=true` is still required: in v1.102.2, disabled CorpDNS returns
from `dnsConfigForNetmap` before exit-node/default resolvers are populated for
Quad100. Enabling it makes Quad100 use the tailnet and exit-node DNS policy;
the resolver file only directs Baileys' separate mount namespace to that
official Tailscale resolver.

The guard atomically writes a marker containing the current host boot ID and
network-namespace inode only after installing its rules. Baileys validates the
read-only marker before loading configuration; a host reboot, namespace owner
restart, stale marker, or guard startup race therefore keeps the process down.
Docker restores the namespace owner before `container:` consumers after an
ordinary daemon restart, and the guard recreates rules before publishing the
new marker. Docker canonicalizes each consumer's network mode to
`container:<full-infra-id>`. The deploy helper verifies that value and compares
`/proc/self/ns/net` inodes from a bounded probe joined to the current owner and
from inside each consumer; it needs Docker access but no host `/proc/<pid>` or
root access. Drifted consumers are rebuilt in strict infra, Tailscale, guard,
Baileys order.

The shared network namespace does not carry the local control channel: both
backend roles continue to mount
`/home/phala/clawdi-whatsapp/run` read-only at `/run/clawdi-whatsapp`, while
Baileys mounts the same host directory read-write and listens on
`/run/clawdi-whatsapp/sidecar.sock`. The UDS therefore remains host-volume
communication and is independent of Tailscale egress.

Every enabled release requires an IPv4-only Docker underlay, the kernel
Tailscale interface, matching shared network namespace, and the IPv4 guard
rules before starting Baileys. A
Tailscale restart does not remove guard rules because the pause container owns
the namespace; a pause restart forces both consumers to be recreated after the
new guard marker.

To disable egress, set the activation variable to `false` (or remove it) and
release. Deployment compares the running network mode and namespace inode with
the desired values and recreates Baileys even if its image is unchanged.
After that release is healthy, an operator may stop and remove the now-unused
Tailscale accessory in a separate deliberate maintenance action. Preserve its
state directory unless intentionally revoking the Tailscale node identity.

Upstream contracts:

- [Tailscale Docker image parameters](https://tailscale.com/kb/1282/docker)
- [Tailscale containerboot environment contract](https://github.com/tailscale/tailscale/blob/v1.102.2/cmd/containerboot/main.go#L14-L63)
- [Tailscale v1.102.2 Quad100/default-resolver construction](https://github.com/tailscale/tailscale/blob/v1.102.2/ipn/ipnlocal/node_backend.go#L1440-L1635)
- [Docker container network mode](https://docs.docker.com/engine/network/#container-networks)
- [Tailscale kernel-mode TUN setup](https://github.com/tailscale/tailscale/blob/v1.102.2/cmd/containerboot/main.go#L327-L347)
- [Kamal 2.12 accessory lifecycle](https://github.com/basecamp/kamal/blob/v2.12.0/lib/kamal/cli/accessory.rb#L78-L89)

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

Backend- or web-only releases must not restart the WhatsApp singleton. Every
release publishes a full-SHA sidecar image, but the workflow derives a stable
deployment revision from the sidecar's effective Docker inputs and Kamal
accessory configuration. The revision hashes emitted source and compiler
configuration, the exact sidecar runtime/build dependency closure selected from
`bun.lock`, and only the `whatsapp-baileys` accessory block. Workspace manifests
copied solely so Bun can validate the monorepo lock are not deployment inputs;
for example, a CLI-only package version bump leaves the revision unchanged. The
workflow reboots the singleton only when that revision differs from the running
container, so a failed or skipped earlier release
cannot make a later commit miss a pending sidecar change. A real sidecar release
verifies the full-SHA image, authenticated UDS healthcheck, and every active
Shared session whose verified phone identity is already durable in PostgreSQL.
Only then does the workflow deploy the new backend and channels worker. The
singleton uses the clean fixed `/home/phala/clawdi-whatsapp/state` root and
stores each session directly at `/data/<provider-session-id>`.

Done: an unrelated release preserves the current singleton process; a sidecar
release exits 0 only after the exact image, global health, and per-session
recovery gates pass.

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

Baileys rc14 defines `DisconnectReason.loggedOut` as status 401 and its pinned
example deliberately does not reconnect that state. This differs from an
ordinary process restart: with valid stored auth, `makeWASocket({ auth })`
reconnects without a QR. Clawdi therefore quarantines a provider-reported 401,
retains the complete SQLite auth and Signal state, and requires an authenticated
explicit recovery action before clearing it for re-pairing. A transport event
must never silently become credential deletion.

Upstream references for the pinned source commit:

- [disconnect reasons](https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/src/Types/index.ts#L28-L38)
- [reconnect handling](https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/Example/example.ts#L70-L103)
- [production auth-state requirements](https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/README.md#saving--restoring-sessions)

## Monitoring

Monitor the accessory health and restart count, active session count,
per-session connection state, provider inbox depth, ingress pump errors, disk
space, SQLite integrity failures, and backup age. Keep the UDS mount
backend-only, rotate the singleton bearer deliberately, and never log it.
