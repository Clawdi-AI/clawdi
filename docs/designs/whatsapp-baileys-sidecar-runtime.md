# WhatsApp Baileys Runtime Boundary

Status: foundation only; rollout disabled
Date: 2026-08-01

> HISTORICAL - Before 2026-08-01 this document described a parallel Cloud
> transport, FastAPI protocol emulation, and Baileys credentials projected into
> agent runtimes. Those paths are retired. This document is the owner for the
> single-socket application-relay design.

## Readiness Gate

WhatsApp remains unavailable to hosted runtime linking. Both
`WHATSAPP_UPSTREAM_READY` and the web linking gate remain `false`.

Offline tests can validate persistence, authorization, replay, adapter bundles,
and typed transport behavior. They cannot validate a linked-device handshake,
real message delivery, provider disconnect behavior, or the advertised Web
version against the live service. Do not enable either gate without completing
the live drill checklist below.

## Fixed Audit Sources

The foundation is designed against immutable source snapshots:

- Baileys `7.0.0-rc13` at
  [`8053b086`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/package.json#L1-L16).
  Its caller-owned auth state is `{ creds, keys }`
  ([`Auth.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Types/Auth.ts#L74-L116)),
  auth-key transactions commit as a unit
  ([`auth-utils.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/auth-utils.ts#L303-L343)),
  and callers must persist `creds.update`
  ([`README.md`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/README.md#L285-L307)).
- OpenClaw `2026.7.1` audit source at
  [`0790d9f5`](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/package.json#L1-L4).
  Its public `ChannelPlugin` owns config, gateway, outbound, message, messaging,
  and actions
  ([`types.plugin.ts`](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/channels/plugins/types.plugin.ts#L54-L110));
  `gateway.startAccount` is the supported background entry
  ([`types.adapters.ts`](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/channels/plugins/types.adapters.ts#L244-L314));
  and the message contract defines durable receive acknowledgement
  ([`message/types.ts`](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/channels/message/types.ts#L310-L348)).
- Hermes `0.19.1` audit source at
  [`f3cda0ce`](https://github.com/NousResearch/hermes-agent/blob/f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1/pyproject.toml#L3-L6).
  User platform plugins are public, opt-in extensions
  ([`hermes_cli/plugins.py`](https://github.com/NousResearch/hermes-agent/blob/f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1/hermes_cli/plugins.py#L948-L1002)),
  and `BasePlatformAdapter` supplies the application adapter surface
  ([`base.py`](https://github.com/NousResearch/hermes-agent/blob/f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1/gateway/platforms/base.py#L2626-L2749)).

These are audit pins, not deployment pins. The default runtime manifest still
uses mutable official installer URLs. A reproducible runtime artifact and
digest are required before rollout.

## Ownership

```text
physical WhatsApp account
  -> one Baileys sidecar process
  -> one WASocket
  -> one exclusive SQLite auth/Signal/retry/operation store
  -> account-scoped normalized callback
  -> FastAPI ChannelAccount -> ChannelBotAgentLink -> ChannelBinding
  -> link-authenticated application relay
  -> default OpenClaw Agent or default Hermes profile
```

The sidecar is the only WhatsApp protocol owner. FastAPI owns tenant access,
bindings, inbox/outbox rows, delivery retry, account lifecycle, and relay
authorization. Agent runtimes receive only a Clawdi link capability; they never
receive a WhatsApp provider token, auth state, Signal key, media key, pairing
secret, or provider socket URL.

One Agent has at most one active WhatsApp bot. A chat or group is a
`ChannelBinding` and a runtime session identity; a runtime cannot address an
arbitrary JID.

## Sidecar State

The SQLite owner persists:

- complete `AuthenticationCreds` and every Signal key category;
- protobuf-correct `AppStateSyncKeyData`;
- exact messages needed by Baileys `getMessage`;
- inbound callback intent and ordered spool state;
- operation id, canonical request hash, result, and ambiguous state;
- database schema version, account owner, package version, and the actual
  advertised WhatsApp Web version.

Baileys can add a participant to a retry request after the original outbound
message was stored without one
([`messages-recv.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/messages-recv.ts#L1463-L1478)).
Outbound retry lookup therefore uses account, chat, message id, and ownership;
participant is not part of that key. Quoted-message lookup is a separate exact
index.

A pending operation found after restart is ambiguous. It is never blindly
resent. An operator must resolve it through the recovery lifecycle.

## Advertised Version Policy

The npm package remains exactly pinned. The sidecar does not call
`fetchLatestBaileysVersion()`: that helper reads the mutable upstream `master`
branch and only falls back to the package default on failure
([`generics.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/generics.ts#L234-L272)).

Initial state records the vetted rc13 default `[2, 3000, 1035194821]`
([`Defaults/index.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Defaults/index.ts#L1-L8)).
Reconnect and restart reuse the persisted value. Health reports the package,
version, and source. A future package/version transition must be an explicit,
audited recovery action.

## Typed Relay

The sidecar accepts bounded, discriminated application operations only:

- send text or media/file, optionally quoting a message;
- edit or delete an owned message;
- react to an unambiguous message;
- set bounded typing/presence state;
- mark explicit inbound messages read.

Baileys exposes the corresponding application methods: edit/delete/reaction
content
([`messages.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/messages.ts#L449-L459)),
read receipts
([`messages-send.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/messages-send.ts#L162-L233)),
presence
([`chats.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/chats.ts#L800-L863)),
and media download
([`messages.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/messages.ts#L1037-L1108)).

No API accepts a raw binary node, IQ, protobuf, provider payload, arbitrary JID,
contact enumeration, group administration, broadcast, status, newsletter, or
hosted identity operation. Unknown inbound content is explicit and bounded; it
does not expose a raw provider message.

PN/LID aliases are learned only from an explicit event pair. The backend never
changes a suffix to invent the other identity. Alias conflicts fail closed. A
group chat is always `@g.us`; PN/LID alternatives apply to the actor, not the
group binding.

## Delivery And Lifecycle

The callback spool writes and fsyncs before delivery, preserves FIFO ordering,
retries network errors, `408`, `429`, and `5xx`, and deletes the head only after
acceptance. Other `4xx` responses, including alias conflicts, put the socket in
a visible fail-stop state.

Lifecycle states are `starting`, `pairing_qr`, `pairing_code`, `connected`,
`disconnected`, `fatal`, and `stopped`. QR and manual codes are returned only
by the authenticated, ephemeral pairing-status response. They are never logged,
included in general health, or cached by the dashboard. Admin actions cover
start, cancel, logout, and recovery. Logout uses Baileys' companion-device
removal
([`socket.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/socket.ts#L731-L755)).

## Capability And Readiness Matrix

| Surface | Foundation contract | OpenClaw | Hermes | Rollout state |
| --- | --- | --- | --- | --- |
| Single socket and durable auth/Signal | Sidecar-owned only | No provider state | No provider state | Offline verified; live drill required |
| Text and replies | Typed, binding-scoped | Inbound-triggered replies use stable event-derived operation ids | Processing-context sends use stable event-derived operation ids | Arbitrary initial outbound denied: neither public contract exposes its stable obligation identity ([OpenClaw](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/channels/plugins/outbound.types.ts#L21-L49), [Hermes send](https://github.com/NousResearch/hermes-agent/blob/f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1/gateway/platforms/base.py#L3476-L3495), [Hermes dispatch](https://github.com/NousResearch/hermes-agent/blob/f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1/gateway/platforms/base.py#L5023-L5080)) |
| Media and files | 8 MiB typed inline content or authorized relay URL | Contextual image/video/audio/file delivery; inbound PTT denied because the public [agent-media payload](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/plugin-sdk/agent-media-payload.ts#L15-L28) has no PTT field | Processing-context image/video/file delivery; authorized relay voice only | Offline verified; live drill required |
| Reactions, typing, read receipts | Typed only where identity is unambiguous | Reaction actions require a caller idempotency key; typing and automatic read implemented | Inbound reactions rendered; processing-context typing and completion-hook read implemented; no generic outbound reaction seam | Unsupported/global operations denied |
| Edit and delete | Owned messages only | Binding-aware actions require a caller idempotency key | Processing-context base methods | Offline verified; live drill required |
| Inbox ACK/restart recovery | Backend ACK only after durable application handoff | Durable journal completes before read/ACK and retries released pending records | Durable journal ACKs from public `on_processing_complete` success and releases failure/cancellation ([`base.py`](https://github.com/NousResearch/hermes-agent/blob/f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1/gateway/platforms/base.py#L4892-L4910)) | Offline restart tests pass; live drill required |
| QR/manual pairing and logout | Admin-only, ephemeral secrets | No runtime QR owner | No runtime QR owner | UI remains disabled |
| Runtime artifact reproducibility | Exact adapter content/digest required | Audit source fixed; installer mutable | Audit source fixed; installer mutable | Blocker |

## Live Drill Checklist

- [ ] Pair a throwaway account by QR without the value entering logs or cache.
- [ ] Pair a second throwaway account by manual code and cancel mid-flow.
- [ ] Verify exactly one socket and one SQLite owner for the account.
- [ ] Exchange direct and group text, replies, files, media, and reactions.
- [ ] Verify PN/LID primary/alternate swaps route to the same binding.
- [ ] Exercise typing, read, edit, and delete only where the runtime advertises
      them.
- [ ] Restart sidecar, backend, OpenClaw, and Hermes at every delivery boundary;
      prove ACK/redelivery and ambiguous outbound recovery.
- [ ] Exercise each transient disconnect reason, logged-out fail-stop, explicit
      recovery, logout, and account deletion.
- [ ] Verify advertised version reporting and an intentionally rejected version
      transition.
- [ ] Verify no runtime contains auth state, Signal keys, provider credentials,
      hidden Agents/profiles, or a second WhatsApp connector.
- [ ] Pin and verify the actual OpenClaw and Hermes runtime artifacts.
- [ ] Run the deployment security and observability review.

Done: the gates remain false, offline checks pass without provider network
access, and every unchecked live drill remains a reported rollout blocker.
