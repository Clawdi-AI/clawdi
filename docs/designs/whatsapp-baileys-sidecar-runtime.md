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
  to the official upstream. A present but invalid, expired, or misplaced marker
  matches the generic deny profile and fails closed.
- FastAPI owns bindings, aliases, durable inbox/outbox state, Link authority,
  Noise/Signal emulation, and revocation. The provider transport has no product
  routing or tenant authority.
- A Noise proxy cannot transparently multiplex synthetic clients onto one real
  account connection. The physical provider socket and Link-scoped synthetic
  sockets are intentionally distinct.

All WhatsApp readiness constants remain false in
`packages/cli/src/runtime/whatsapp-upstream-contract.ts`. No managed marker,
credential projection, or interception profile is installed in production.

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

## Exact Upstream Proposal

Pinned Baileys `7.0.0-rc13` already passes `SocketConfig.options.headers` to
`ws`, but the same `RequestInit` is also used for provider HTTP/media fetches.
It is therefore not a safe dedicated marker seam. The narrow upstream change
is:

```ts
export type NoiseCertificateAuthority = {
  SERIAL: number;
  ISSUER: string;
  PUBLIC_KEY: Uint8Array;
};

export type SocketConfig = {
  // Existing fields omitted.
  authCert?: NoiseCertificateAuthority;
  webSocketHeaders?: Record<string, string>;
};
```

`makeNoiseHandler` must verify the intermediate signature and issuer serial
against `authCert ?? WA_CERT_DETAILS`. `WebSocketClient.connect` must merge only
`webSocketHeaders` into the `ws` upgrade headers; it must not copy them to
fetch/media requests. Defaults preserve current upstream behavior.

Release tests must run against both consumer artifact names used here,
`baileys` (OpenClaw) and `@whiskeysockets/baileys` (Hermes):

1. no options still trust the official certificate and emit no marker;
2. `authCert` accepts a fixture chain signed by the supplied authority and
   rejects the official/wrong authority and serial;
3. `webSocketHeaders` appear on initial and reconnect upgrades only;
4. the marker is absent from fetch, media upload/download, redirects, and logs;
5. both artifact aliases expose identical types and runtime behavior.

OpenClaw and Hermes then need a native-plugin configuration field that resolves
the Link marker secret and passes it as `webSocketHeaders`. Clawdi must not
monkey-patch, rewrite modules, override package resolution, or ship a custom
ChannelPlugin/BasePlatformAdapter to simulate this seam.
