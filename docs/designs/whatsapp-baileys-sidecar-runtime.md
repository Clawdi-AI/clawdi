# WhatsApp Baileys Application Runtime

Status: foundation only; runtime projection disabled
Date: 2026-08-01

## Decision

Clawdi will use exactly one physical `@whiskeysockets/baileys` sidecar for each
linked WhatsApp account. That sidecar alone owns the provider socket and the
provider authentication state. It sends normalized application events to the
Clawdi backend and accepts a narrow final-text application send operation.

Clawdi owns the product control plane: physical account registration,
`AgentLink` and `Binding` authorization, account-scoped deduplication, durable
application inboxes, monotonic acknowledgements, and outbound idempotency. An
Agent/runtime provider may have at most one active WhatsApp account/link.

OpenClaw and Hermes must eventually consume the authenticated Clawdi
application inbox and outbound endpoint through documented external plugin
surfaces. They must not receive the real `AgentLink` token or any Baileys auth
state. Runtime egress will substitute a deterministic placeholder bearer only
for exact control-plane host, path, and HTTP method matches.

This is not a shared raw socket design. Clawdi does not copy authentication,
multiplex Noise or Signal sessions, create synthetic WhatsApp identities, or
run a native Baileys client inside an Agent runtime.

## Current foundation

The sidecar package at `packages/whatsapp-baileys-sidecar` uses the installed
`@whiskeysockets/baileys@7.0.0-rc13` contracts and currently provides:

- one `makeWASocket` owner for one physical account;
- `messages.upsert` ingestion for `notify` only; `append` and `replace` do not
  create application turns;
- normalized text events for PN/LID direct messages and groups, with group chat
  routing separate from the participant actor;
- explicit rejection or omission of status, broadcast, newsletter,
  sent-by-self, and unsupported media-only events;
- a durable callback journal outside the auth `sessionDir`, with atomic writes,
  file and directory fsync, monotonically ordered filenames, crash recovery,
  Clawdi-2xx deletion, and hard event and byte limits;
- sticky fatal/degraded behavior on callback capacity exhaustion, auth/key
  persistence failure, or retry-message persistence failure; the socket does
  not automatically reconnect from these states;
- a narrow `POST /v1/messages` final-text/reply operation requiring a stable
  caller `messageId`;
- exact quoted-message lookup from a bounded sidecar-local retry store; a miss
  fails closed instead of fabricating an empty protocol message; and
- compatibility-only raw relay, raw node, and IQ routes. These routes are not
  an application runtime contract and are retained for existing consumers
  pending a separately audited cutover.

Provider auth and Signal keys are stored transactionally in
`sessionDir/baileys-state.sqlite` with `BufferJSON` encoding. The same local
SQLite database has a bounded, expiring message retry store keyed by physical
account and the complete `WAMessageKey`. Callback event payloads never contain
the stored protobuf. The callback journal is a separate persistence domain and
must not overlap `sessionDir`.

The backend foundation currently provides:

- sidecar ingress authentication tied to the configured physical-account
  registration and disabled when that registration has no `ingress_token`;
- strict independent normalized-event validation and account-scoped dedupe;
- JID alias routing, Binding-scope pairing, participant actor semantics for
  groups, and a minimal durable inbox payload;
- per-account-key Link-token authentication for inbox GET, ack POST, and final
  outbound POST, with exact active Binding/Link ownership; and
- stable `clientMessageId` reuse through backend retry and metadata-commit
  failure. A provider success remains a success response even if the
  best-effort metadata update fails.

Pairing and unpairing replies happen only after the durable database commit.
Reply delivery failure is logged and does not roll back the binding change or
retry the provider event.

The CLI transparent-egress foundation matches the HTTP method exactly and has
WhatsApp-specific same-control-plane-host profiles for the inbox GET, ack POST,
and outbound POST paths. Host, path, method, and placeholder mismatches do not
rewrite authorization, and the egress process UID is excluded from recursive
interception.

## Upstream contract evidence

The implementation follows the installed rc13 source rather than older guide
snippets:

- The locally installed
  `packages/whatsapp-baileys-sidecar/node_modules/baileys/README.md` from
  `@whiskeysockets/baileys@7.0.0-rc13`, “Saving & Restoring
  Sessions,” says `useMultiFileAuthState` is a guide and recommends a SQL or
  NoSQL auth/key store for production-grade systems. The following note says
  Signal keys update during message send and receive and must be persisted.
- The same installed README, “Improve Retry System & Decrypt Poll Votes,”
  requires a real store-backed `getMessage`. The sidecar returns the exact
  local message or `undefined`; it never substitutes `{ conversation: "" }`.
- The installed `node_modules/baileys/lib/Types/Message.d.ts`,
  `MinimalRelayOptions.messageId`, documents the
  custom message-id override.
- The installed `node_modules/baileys/lib/Socket/messages-send.js` constructs a
  generated default `messageId` and
  then spreads caller `options`, so the application caller's stable ID wins.
- The installed `node_modules/baileys/lib/Utils/messages.js`,
  `generateWAMessageFromContent`, normalizes the
  supplied quoted `WAMessage.message`. A quoted reply therefore uses a real
  locally stored message and cannot use an empty placeholder.

## Disabled release boundary

Both CLI gates remain false in this foundation:

- `WHATSAPP_APPLICATION_RUNTIME_PROJECTION_READY = false`
- `WHATSAPP_LEGACY_RUNTIME_PROJECTION_READY = false`

No projectable OpenClaw or Hermes WhatsApp application adapter is included.
The audited public extension surfaces have not yet been exercised end to end
against the installed upstream runtimes. Documentation and fixtures do not
count as that E2E. Until real adapters and the complete local fake flow exist,
projection must not install `@openclaw/whatsapp`, materialize
`HERMES_WA_CREDS_JSON`, copy `creds.json`, or expose a real Link token.

Current application capability is final text and reply only. Media, read
receipts, and typing are not implemented by the application sidecar contract,
so they remain disabled rather than being represented as supported frames.

## Compatibility and later removal

The existing backend `/tenant-creds` and `/{account_id}/baileys` surfaces stay
reachable for compatibility. Historical credential/auth-certificate reads and
unlink/delete cleanup also remain. Legacy Python Noise, synthetic credential,
and credential-projection code must not be newly enabled.

The final product direction removes the Meta WhatsApp Cloud API transport and
fallback. That removal is not part of this foundation because the sidecar does
not yet cover the existing media, read, and typing consumers. The Graph config,
Cloud payload/media/typing/read code, provider send path, Graph facade,
`phone_number_id` fields, helpers, and tests must be removed together only after
replacement capability and active-consumer audits pass. Clawdi's own cloud
control-plane URL is unrelated and must remain.

## Exit criteria

The application gate may change only after all of the following are complete:

1. exported, documented OpenClaw `ChannelPlugin` and Hermes
   `ctx.register_platform(BasePlatformAdapter)` adapters exist without private
   dist imports or copied upstream internals;
2. a local fake E2E proves sidecar inbound, backend dedupe/routing, per-Link
   inbox, adapter reconnect/replay/ack, stable outbound idempotency, and fake
   sidecar delivery for both runtimes;
3. an explicit admin lifecycle owns QR/pairing status, account replacement,
   shutdown, and operator recovery without exposing provider auth to runtimes;
4. the sidecar covers media, read, and typing plus each required Cloud
   compatibility consumer before the corresponding Meta transport is removed;
   and
5. parent review explicitly approves enabling the application path.

No real-account smoke, deployment, or production operation is authorized by
this document.
