# WhatsApp Baileys Sidecar Foundation

Status: disabled foundation

## Boundary

Each configured WhatsApp account has one physical
`@whiskeysockets/baileys` sidecar. The sidecar alone owns the WhatsApp Web
socket, auth credentials, Signal keys, and bounded retry-message store.

The backend keeps the existing authorization chain:

```text
ChannelAccount (physical WhatsApp account)
  -> ChannelBotAgentLink (one hosted Agent capability)
    -> ChannelBinding (one paired DM or group chat)
```

One hosted Agent may have at most one active WhatsApp account Link. Existing
WhatsApp creation/linking remains unavailable to hosted Agents, and
`WHATSAPP_UPSTREAM_READY` remains `false`. No OpenClaw or Hermes config,
credential, plugin, profile, token, or auth-state projection is enabled.

This foundation does not add or emulate the Meta Cloud API. It adds no Graph
route, Cloud payload facade, transparent-egress profile, placeholder token, or
hidden runtime Agent/profile. Existing legacy compatibility code is not a
dependency of the new sidecar event path.

## Pairing

On an unregistered Baileys session, the sidecar handles the `qr` value from
`connection.update` and renders a scannable QR in the physical sidecar
terminal. The same authenticated local health response contains the current QR
payload so an operator surface can render it without scraping logs.

For the upstream manual pairing-code alternative, set an E.164 number without
`+` or separators:

```dotenv
CLAWDI_WA_PAIRING_PHONE_NUMBER=15551112222
```

After Baileys emits its first QR (which proves the websocket is ready), the
sidecar calls `requestPairingCode` once for that socket and writes the copyable
code to its terminal. The code and QR are ephemeral and are cleared on connection or
disconnect; neither is persisted in the auth database or callback spool.

Chat authorization remains separate from device pairing. A user generates the
existing one-time Clawdi pair code and sends the existing manual message in the
WhatsApp chat:

```text
/bot_pair PAIRXXXXXXXX
```

The backend commits the pair/unpair result before asking the sidecar to send
the reply. A reply failure does not roll back the binding.

## Durable State

The sidecar writes `baileys-state.sqlite` under
`CLAWDI_WA_SIDECAR_SESSION_DIR` with SQLite WAL and `synchronous=FULL`:

- auth credentials use Baileys `BufferJSON` encoding;
- Signal key batches update transactionally;
- retry messages are keyed by account plus the complete `WAMessageKey`;
- normalized callback handoff intent is committed in the same SQLite
  transaction as its exact retry messages;
- retry storage has count, byte, and TTL limits; and
- a missing quoted message fails closed instead of fabricating content.

The session database holds an exclusive SQLite lease, and the session/spool
directories and state files are restricted to owner access. If legacy
`useMultiFileAuthState` JSON is present, startup fails closed instead of
silently generating a different identity; an explicit full-state migration is
required before reuse.

Normalized inbound `messages.upsert` events use `notify` only. History,
replacement, self-sent, status, broadcast, newsletter, and unsupported
media-only events do not become Agent turns. PN/LID aliases stay account
scoped; a group JID is the chat while the participant JID is the actor.

Before delivery, each normalized batch is atomically written to the separate
callback spool configured by `CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR`. Recovery
preserves monotonic file order. Events remain until the account-scoped backend
endpoint returns 2xx. Capacity or persistence failure stops the provider socket
in a sticky fatal state and requires operator restart. If the file-spool
handoff fails, the still-pending SQLite intent is replayed on restart, so the
received batch does not depend on unproven provider redelivery. Permanent 4xx
callback rejection also fails stop with the durable head retained.

Transient connection closes create a fresh socket with exponential jittered
backoff capped at 60 seconds. Logout, replaced connection, bad session,
multi-device mismatch, forbidden, unknown, and fatal persistence closes remain
stopped for explicit operator recovery.

Provider event identities hash the complete chat/message/participant key, so
opaque message IDs from different chats cannot collide within an account. The
sidecar applies the backend's text and metadata limits before journaling, which
prevents a permanently invalid event from poisoning the FIFO.

The backend authenticates ingress with the configured account's independent
`ingress_token`, deduplicates by `(account, provider event)`, resolves the
account's Link and chat binding, writes the inbound `ChannelMessage`, and only
then returns success. The generic webhook secret and AgentLink token cannot
authorize sidecar ingress.

## Upstream Evidence

This package pins `@whiskeysockets/baileys@7.0.0-rc13` (tag commit
`8053b086ecc97ec3f78299561de11959bab05d39`):

- [`SocketConfig`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Types/Socket.ts#L56-L64)
  marks `printQRInTerminal` deprecated, while
  [`ConnectionState`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Types/State.ts#L21-L31)
  exposes `qr`; the sidecar therefore owns QR rendering.
- [`requestPairingCode`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/socket.ts#L758-L807)
  is the upstream manual alternative; it is used only when the explicit phone
  number setting is present.
- The upstream
  [session guidance](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/README.md#L285-L307)
  recommends a SQL/NoSQL auth store for production and requires Signal key
  updates to be persisted.
- `SocketConfig.getMessage` is an explicit
  [store-backed callback](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Types/Socket.ts#L137-L144),
  and upstream retry/poll guidance requires real stored content.
- [`MinimalRelayOptions.messageId`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Types/Message.ts#L304-L312)
  and message construction's
  [caller override](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/messages.ts#L748-L757)
  support stable sidecar message IDs.

OpenClaw and Hermes remain a capability boundary, not an implementation claim.
Their current built-in WhatsApp paths own their own provider sessions and do
not export a verified Clawdi sidecar-consumer contract. Projecting the physical
auth state into either runtime would create a second provider owner and is
forbidden by this design.

## Limitations

- No OpenClaw or Hermes WhatsApp runtime adapter is enabled.
- No media download/upload, reactions, typing, or read receipts exist on the
  normalized sidecar contract.
- Pair/unpair reply delivery is best effort after the durable binding commit.
- Spool-capacity exhaustion is fail-stop and needs operator recovery.
- No live-account, deployment, or production verification is part of this
  foundation.

## Verification

```bash
bun run --cwd packages/whatsapp-baileys-sidecar typecheck
bun run --cwd packages/whatsapp-baileys-sidecar test:local
```

Done: both commands exit 0; tests cover SQLite restart/rollback, bounded retry
storage, callback recovery/order/caps, normalized ingress, pairing exposure,
quoted replies, and the authenticated sidecar HTTP contract.
