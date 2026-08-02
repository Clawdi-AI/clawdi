# WhatsApp Physical Provider Transport and Native-Agent Noise Boundary

Status: gated; no production projection
Date: 2026-08-02

The package name `packages/whatsapp-baileys-sidecar` is retained to avoid
manifest and CI churn. It is the physical provider transport, not an OpenClaw
or Hermes channel connector and not a second agent runtime.

## Invariants

- One real WhatsApp account has exactly one Clawdi-owned physical Baileys
  socket. It owns the real linked-device auth, Signal keys, retry state,
  reconnect, QR, and pairing lifecycle.
- An OpenClaw or Hermes native WhatsApp plugin runs its own pinned stock Baileys
  with synthetic, Link-scoped Clawdi auth state. It never receives the physical
  account auth directory, credentials, or token.
- The synthetic socket connects to the FastAPI Noise emulator only when its
  WebSocket upgrade carries the exact managed marker. The generic egress engine
  strips the marker and injects the AgentLink bearer before forwarding.
- A missing marker is a user-owned socket and remains request-level passthrough
  to the official upstream. A present but invalid, stale, or misplaced marker
  matches the generic deny profile and fails closed.
- FastAPI owns bindings, aliases, durable inbox/outbox state, Link authority,
  Noise/Signal emulation, and revocation. The provider transport has no product
  routing or tenant authority.
- A Noise proxy cannot transparently multiplex synthetic clients onto one real
  account connection. The physical provider socket and Link-scoped synthetic
  sockets are intentionally distinct.

The four isolated, compatibility-patch-provided artifact-seam audit fields are
true; none is described as a native upstream capability. The aggregate
WhatsApp linking, runtime, and upstream readiness constants remain false in
`packages/cli/src/runtime/whatsapp-upstream-contract.ts`. Native-plugin E2E and
the live-account drill are still unproven. No managed marker, compatibility
patch, credential projection, or interception profile is installed in
production.

## Data Flow

Provider ingress:

```text
physical Baileys socket
  -> Baileys event/proto at the provider boundary
  -> FastAPI binding and alias resolution
  -> durable channel_messages inbox row
  -> Link-scoped Noise session
  -> stock native plugin Baileys
```

Agent egress:

```text
stock native plugin Baileys
  -> managed marker selected by a provider profile
  -> generic egress rewrite injects AgentLink bearer
  -> FastAPI validates Link + synthetic Noise identity + binding ownership
  -> messages enter durable channel_messages/channel_deliveries
  -> the delivery worker relays the exact provider proto
  -> receipts and bounded key/group IQs use narrow authorized operations
  -> the account's sole physical Baileys socket
```

The backend may inspect only the JIDs, message ids, and node attributes needed
for ownership and binding policy. It must preserve Baileys proto/BinaryNode
fidelity and must not translate through Meta Graph payloads.

## Physical Provider Transport

`BaileysSocketRuntime` calls `makeWASocket` once for one configured provider
account. `CLAWDI_WA_PROVIDER_ACCOUNT_ID`, `CLAWDI_WA_SIDECAR_TOKEN`, and
`CLAWDI_WA_SIDECAR_SESSION_DIR` are required. The historical
`CLAWDI_WA_WEBSOCKET_URL` override is intentionally unsupported: the physical
socket always uses Baileys' official upstream URL.

The session directory contains one `provider-state.sqlite` database for auth
credentials, Signal keys, retry counters, exact retry message protos, immutable
account/release metadata, and the bounded provider ingress spool. It uses
SQLite WAL, `synchronous=FULL`, transactional key batches, and
`locking_mode=EXCLUSIVE`; startup verifies all three settings. The SQLite
advisory lock is the one-owner mechanism. There is no PID file to mistake for a
live owner after a host restart.

The database is immutably bound to the canonical provider account UUID, pinned
Baileys release, and audited WhatsApp Web version before auth opens. A mismatch
fails closed and requires an explicit complete migration; startup never
rewrites identity metadata or partially imports the removed JSON/multi-file
state. Existing database/WAL/shared-memory paths are verified as regular files
before SQLite opens them, so a symlinked state path fails closed. The default
ingress limits are 10,000 events and 256 MiB, configurable
downward or upward within validated hard bounds. Ingress sequence uses SQLite
`AUTOINCREMENT`, so acknowledging an empty queue does not reset it on restart.

Each inbound `messages.upsert` batch is committed synchronously before the
Baileys event handler returns. This transport does not claim control of a
provider ACK that Baileys does not expose. FastAPI acknowledges a spool
sequence only after its durable inbox transaction commits. Corrupt state,
capacity exhaustion, transaction/write failure, or an unavailable durability
mode fail-stops the physical socket instead of logging and dropping an event.

Production does not call `fetchLatestBaileysVersion()`. Baileys is fixed at
`7.0.0-rc13`, and the configured Web version is exactly
`2.3000.1035194821`. This was audited on 2026-08-02 against the installed
release and upstream source commit
[`8053b086`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Defaults/index.ts),
whose default is the same tuple. Reconciliation is deliberate: update the
fixed package release, audited source/tuple, tests, and documentation together,
then run an explicit state migration. Existing state refuses a silent version
change.

FastAPI registers one provider transport per account through
`CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON`. Its bearer-authenticated HTTP contract
is private. Every registration requires a non-empty, redacted `api_token`.
The containing backend setting is also represented as a secret rather than
rendering the registration JSON in process diagnostics.
`base_url` must be an origin without userinfo, path, query, or fragment; plain
HTTP is accepted only for exact loopback hosts and every non-loopback origin
must use HTTPS.

| Method | Path | Required native operation |
| --- | --- | --- |
| `GET` | `/v1/health` | Observe the configured physical socket. |
| `POST` | `/v1/relay-message` | Relay an authorized Baileys message proto with its message id and attributes. |
| `POST` | `/v1/raw-node` | Send an ownership-checked receipt or other allowed BinaryNode. |
| `POST` | `/v1/query-iq` | Forward the bounded IQ subset required by the synthetic Noise session. |
| `GET` | `/v1/provider-events` | Read ordered physical `messages.upsert` proto events after synchronous SQLite persistence. |
| `POST` | `/v1/provider-events/ack` | Delete physical events only after FastAPI commits them. |

These are provider-transport operations behind an internal bearer, not a
public application relay API. Raw nodes and IQs remain because the native Noise
bridge calls them after backend policy checks; removing them would break
receipts, key/group queries, and protocol fidelity.

Current repair verification: `bun test packages/whatsapp-baileys-sidecar/src`
reports 28 passing tests. It covers restart, transaction rollback, corrupt
state, `creds.update`, Signal get/set/delete/clear, empty-queue sequence
monotonicity, capacity, persistence fail-stop, exact pinned socket version,
immutable account binding, exclusive ownership, and pre-open symlink rejection.

## Generic Egress Layering

`packages/cli/egress-addon/clawdi_egress_addon.py` interprets only declarative
profiles: scheme, host, path, query, header, expiry, priority, rewrite,
deny/passthrough, and redaction. It contains no provider hostname, marker, or
channel-specific branch.

Provider builders choose the natural placeholder location:

- Telegram: placeholder in the Bot API path.
- Discord: placeholder in Authorization or gateway identity.
- WhatsApp: managed WebSocket-upgrade marker header. This marker selects a
  profile; it is not a WhatsApp token or backend credential.

Done: `python3 -m unittest packages/cli/tests/egress_addon/clawdi_egress_addon_test.py` exits 0 and
`test_generic_engine_source_contains_no_channel_product_constants` passes.

## Audited Native Artifacts

The compatibility surface was audited from the actual pinned installation
layouts, not inferred from source package names:

| Consumer | Audited stock identity | Installed Baileys alias | Stock auth lifecycle |
| --- | --- | --- | --- |
| OpenClaw | `@openclaw/whatsapp@2026.7.1` | `node_modules/baileys`, audited at `7.0.0-rc13` | Loads Baileys multi-file auth, preserves `additionalData` with `BufferJSON`, and reconstructs through `createWaSocket`. |
| Hermes | release `2026.7.30`, package `0.19.1` | `node_modules/@whiskeysockets/baileys`, audited at `7.0.0-rc13` | `startSocket` reloads multi-file auth, subscribes `creds.update` to `saveCreds`, and calls `startSocket` again on reconnect. |

Both audited aliases resolve to Baileys source commit `8053b086`. The consumer
identities document the stock call chains; they are not patch targets or
reconcile identity authority. The only consumer-specific identity needed at
runtime is the known package-root alias used to locate Baileys.
The older local `7.0.0-rc.9` patch was reviewed only for the backward-compatible
`authCert ?? WA_CERT_DETAILS` trust behavior; its custom websocket URL routing
and release assumptions are intentionally absent.

## Static Compatibility Patch

Pinned Baileys `7.0.0-rc13` already passes `SocketConfig.options.headers` to
`ws`, but the same `RequestInit` is also used for provider HTTP/media fetches.
It is therefore not a safe dedicated marker seam. Revision
`clawdi.managedBaileysCompat.v2` changes only three Baileys files:

| Target | Pristine SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `lib/Socket/socket.js` | `ab9b68888e123ad683dbc26555fc928400c1526c93ec6b66853f2ba30f8177a9` | `3e4ce87fc485635c9ada35cc4056110136356fcb3b549955a7518943d45082c0` |
| `lib/Utils/noise-handler.js` | `970f9526ce0e5a6bebf937328b3d835966a9282c0d232f31b5c0bb283531afe8` | `be9d357b337b20f2d678c68d1c989091187a8fa6f767af92645dba05b827f206` |
| `lib/Utils/noise-handler.d.ts` | `a556ca0b67c3448769ad5ed0d59acbf566a21115fa107cd582b1dcb28c4fd516` | `34197090723b4b197b36062d8283f86ada1f8d5863a58efab446b8bf87f2e28e` |

The CLI embeds validated Link metadata under
`creds.additionalData["clawdi.managedWhatsAppSocket"]`. Patched `makeSocket`
strictly validates exact keys, schema, selector shape, safe serial, trimmed
issuer, and 32-byte public key. A present malformed value fails before a
network connection. A valid value derives a copy used only by
`WebSocketClient`, adds the selector header there, passes the public trust to
`makeNoiseHandler`, and forces the official
`wss://web.whatsapp.com/ws/chat`. The original config remains unchanged for
HTTP/media users. If the namespaced value is absent, the original config,
including consumer URL/options and official `WA_CERT_DETAILS`, is used exactly
as before.

Compatibility tests run against both consumer artifact names used here,
`baileys` (OpenClaw) and `@whiskeysockets/baileys` (Hermes). The executable
harness evaluates the patched rc13 socket prologue and full Noise handler,
calls rc13 `getHttpStream`, and runs stock Baileys auth load/save/reload cycles
matching both audited consumer call chains:

1. absent metadata retains a consumer custom URL/options, emits no marker, and
   trusts the official certificate;
2. valid metadata forces the official URL and uses the supplied public key and
   serial;
3. the marker appears in WebSocket upgrade options but not in the unchanged
   config passed to real rc13 media fetch;
4. malformed present metadata fails closed;
5. OpenClaw-style `BufferJSON` persistence and Hermes `saveCreds` both preserve
   the namespace and Buffer, and reconstruction rereads changed Link metadata.

This is executable compatibility-seam evidence, not full native-plugin E2E.
The native-plugin and live-account gates therefore remain false.

The CLI reconciler is a narrow static compatibility exception to the general
ban on runtime monkey-patching and source forks. It performs no fuzzy or
load-time replacement, does not override package resolution, and ships no
custom ChannelPlugin or `BasePlatformAdapter`. It patches no OpenClaw or Hermes
source. Stock auth persistence carries the namespaced metadata into every
initial and reconstructed socket. Without that namespace both consumers and
Baileys preserve stock behavior.

### Reconcile and Recovery

The receipt is
`<installInventory>/managed-baileys-compat.json`. Reconciliation is:

1. With no managed Link, no receipt means inert. A matching receipt triggers a
   full rollback preflight; exact postimages return to exact preimages and the
   receipt is removed. An entirely absent audited artifact root means the
   package was uninstalled and its receipt can be forgotten. If the root still
   exists, every package identity and target must exist and match an audited
   preimage or postimage; a missing target, symlink, identity mismatch, or
   unknown hash refuses the entire rollback before any target mutation and
   preserves the receipt.
2. With a managed Link, Hermes first restores lockfile-pinned local bridge
   dependencies when Baileys is absent. The live-state transaction snapshots
   the whole `node_modules` tree whenever that `npm ci` may run.
3. The reconciler verifies the real, non-symlinked Baileys package root, the
   expected alias package name, a rigorously parsed SemVer major 7, and every
   target's exact pristine or patched SHA-256. A different valid 7.x version is
   accepted only when all audited target bytes still match. Major 8, other
   majors, malformed versions, missing targets, and source drift fail closed.
   It does not claim registry/tarball integrity verification: npm integrity is
   not present in installed `package.json` and is not receipt authority.
4. Exact patched files plus a matching receipt are a no-op. Exact patched files
   without a receipt recover the receipt. A compatible 7.x version transition
   updates the observed version in the receipt without rollback. Pristine or
   mixed recognized files write and fsync the receipt, stage all replacements,
   recheck every source hash, then rename each target and fsync its directory.
   Each rename is an atomic file replacement, but the three-file change is not
   a global atomic transaction. A crash can leave a recognized
   preimage/postimage mixture; the durable receipt makes the next reconcile
   converge it safely.
5. An installer restore to recognized pristine files reapplies the patch.
   Manifest convergence failure restores the exact pre-apply live snapshot.
   Rollback also preflights every target before changing any file. A crash
   during rollback leaves the receipt until every target is restored, so the
   next rollback converges a recognized mixed state.

The receipt contains only its schema, patch revision, audited Baileys package
root, runtime/alias, observed compatible version, compatible major, relative
target paths, and pre/post SHA-256 values. The reconciler remains larger than
the 36 net added upstream lines because it retains package-layout recovery,
strict SemVer/name checks, symlink checks, TOCTOU rechecks, durable staging,
receipt/version-transition recovery, rollback preflight, Hermes reinstall
handling, and caller snapshot compatibility. Consumer patch definitions,
consumer identities, sidecar config state, timestamp and unverifiable integrity
fields, multi-artifact receipt state, and duplicate commit code are absent.

Done: `bun test --isolate packages/cli/src/runtime/managed-baileys-compat.test.ts packages/cli/tests/managed-whatsapp-projection.test.ts packages/cli/tests/runtime-whatsapp-egress.test.ts` exits 0 and reports no failures.
