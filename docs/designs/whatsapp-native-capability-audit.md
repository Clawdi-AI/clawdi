# WhatsApp Native Consumer Capability Audit

Status: current integrity review draft; historical pinned-consumer audit below
Original audit date: 2026-08-03; integrity review: 2026-09-13

## 2026-09-13 integrity review (draft)

This section supersedes the transport conclusions below; the August consumer
matrix remains evidence for its exact pinned artifacts, not all installed
Hermes/OpenClaw versions. No live account, pairing QR, external message, or
production operation was used in this review.

The physical sidecar now pins Baileys rc14 at
[`7e7b0757`](https://github.com/WhiskeySockets/Baileys/tree/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a).
The stock-consumer fixture still pins rc13 through OpenClaw `2026.7.1` and
Hermes commit `cc4cab2f`. CLI compatibility patch admission is separately
owned by `packages/cli/src/runtime/managed-baileys-compat.ts`; it must not be
inferred from a passing rc14 sidecar test.

### Confirmed fixes

- The SDK service JID is `@s.whatsapp.net`, not the hostname literal used in
  the original audit and its tests. Both rc13 and rc14 define this exact
  [`S_WHATSAPP_NET`](https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/src/WABinary/jid-utils.ts#L1).
  The real consumer fixture captured `iq get privacy to=@s.whatsapp.net`
  with one empty `privacy` child. Before this fix, the isolated OpenClaw
  receipt had no type and Hermes used `inactive`; neither proved a read receipt.
  Only the existing media/privacy service IQ contract now accepts that exact
  SDK target plus its previously accepted hostname literal. General JID
  decoding, chat binding and raw-node authorization are unchanged. Neighboring
  domains, user JIDs and broadcasts still fail closed. This security-sensitive
  compatibility correction requires root review before publication.
- Authorized provider IQs now resolve the durable session on an API worker
  without a local ingress registration, as raw nodes already did. Media
  connection and privacy queries retain the exact existing allowlist.
- Delivery, raw nodes and IQs reuse the existing lifecycle-managed sidecar
  control pool. The extra global delivery HTTP pool is removed. Restarting
  that pool uses its new token without retaining an older service client.
  A token change does not change the non-secret endpoint/session revision.
- Public and debug health query the revision-fenced session instead of
  treating process-local ingress registration as proof of connectivity.
  Custom session IDs remain distinct from product account IDs.
  Health lists release their read/auth database session before network I/O.
  Four fixed workers share a two-second probe budget; each account has a
  0.5-second deadline. Declared managed/custom bindings must resolve against
  the current revision and session before any health is trusted; an older green
  registration cannot rescue an invalid binding. Only registrations with no
  declared sidecar binding retain the legacy local-health path.
  Started probes move to the back of the existing pool's ordered session-client
  dictionary. Repeated requests on that pool therefore reach an eligible tail
  behind a slow prefix, without a tenant cursor cache or timestamp rotation.
  Fairness resets with the pool lifecycle; there is no global cross-worker cursor.
  Unstarted/cancelled probes report `provider-transport-not-probed` (Status
  unknown), do not advance failure clocks, and differ from a failed probe. This bounds the
  network phase; database snapshot queries keep their existing database limits.
  Only a fully validated health response updates the client's connected flag;
  protocol errors/cancellation clear it and successful recovery resets the
  existing unavailability clock. No cache TTL or new background worker is added.
- Durable outbox failure now propagates through Noise handling, closing the
  websocket without a success message ACK. A local queue ACK still does not
  claim delivery to a physical recipient.
  That change alone did not prevent ACK-loss replays after a successful commit.
  The canonical producer now holds a PostgreSQL transaction advisory lock for
  `(account, Link, canonical chat, stanza ID)` and looks up the original ID in
  the retained `providerPayload`, not the mutable physical `provider_message_id`.
  An identical canonical provider envelope returns the existing Message/Delivery
  receipt. Proto-only comparison was insufficient: changing `edit` or the poll
  creation node must conflict even when the proto is unchanged. Both retained and
  incoming payloads now pass the existing delivery decoder/encoder: the comparison
  includes exact proto, every attribute returned by `relay_outbound_extra_attrs`,
  and validated/normalized additional nodes. Missing/empty optional nodes normalize
  identically. Only `encType` and the already-discarded managed routing attributes
  are excluded; all forwarded attributes (including `edit`, `addressing_mode` and
  `device_fanout`) remain significant. No new retry-metadata allowlist is introduced.
  rc14 [constructs edit/poll metadata](https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/src/Socket/messages-send.ts#L1374-L1407)
  separately from the proto and [rebuilds Signal/device routing](https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/src/Socket/messages-send.ts#L963-L1021).
  Semantic changes, malformed retained envelopes and ambiguous historical duplicates
  fail with a conflict; replays never overwrite the first accepted envelope.
  This reuses existing payload rows and works across processes; it adds no process
  cache, permanent receipt table, database uniqueness constraint or backfill.
  Its guarantee ends when retention deletes the original row. Previously queued
  duplicates are not automatically deleted, and physical delivery is not exactly-once.
  Standard Baileys [sendMessage](https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/src/Socket/messages-send.ts#L1364-L1407)
  gives each edit a new stanza ID, while its [protocol key](https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/src/Utils/messages.ts#L641-L647)
  refers to the original target message. Successive edits to that same target
  are distinct operations. Reusing an outer stanza ID with different provider semantics
  is a conflict; the producer does not guess a new edit version from a changed body.
- Only malformed inbox preparation is terminally skipped. Delivery-stage
  errors, including Signal `ValueError`, leave the failed and later rows
  unacknowledged for retry.
- An unsuccessful forwardable provider IQ returns an error child, rather than
  an empty success. This uses Baileys' official
  [`assertNodeErrorFree`](https://github.com/WhiskeySockets/Baileys/blob/7e7b0757e3f9f3c7789fb1cfd2f241d5002a199a/src/WABinary/generic-utils.ts#L66-L71)
  contract. Local bootstrap IQ handling remains separate.

### Current capability and evidence matrix

“Covered” below means hermetic behavior at the stated boundary. It never means
that a real phone accepted the operation.

| Capability | Product boundary and implementation | Offline evidence / limit |
| --- | --- | --- |
| QR, phone code, cancel, expiry, retry, re-pair | Device onboarding reserves a session; phone code is capability-gated; explicit logout/recovery controls auth clearing. | `test_whatsapp_custom_onboarding.py`, `test_whatsapp_managed_onboarding.py`, sidecar runtime/server tests. No real QR or phone validation. |
| Physical credentials, rotation, restart | SQLite auth/Signal/retry/inbox; remote 401 quarantines auth. API control-pool restart refreshes its bearer. | SQLite/runtime tests, cross-pool IQ integration. Live rotation and recovery remain unexecuted. |
| Text, quotes, group mentions | Exact message proto and bound chat routing; no application translation. | Noise/bridge tests plus sidecar HTTP → SQLite retry → socket fixture using native proto. |
| Image, audio/PTT, video, document | Proto bytes and bounded media-connection IQ; native SDK owns upload/download and encryption. | Native media proto variants plus real resolver/HTTP media IQ test. No actual upload/download or media rendering proof. |
| Reactions, edit, delete | Exact reaction/protocol proto; consumer availability differs as recorded below. | Bidirectional native proto fixture includes reaction, edit and revoke. This does not add missing consumer commands. |
| Receipts, typing | Binding-authorized raw receipt/chatstate; scoped participant attributes retained. | Raw-policy and bridge tests; physical delivery/read status is not replayed to Agents. |
| Global presence | No chat target; account identity operation is outside the binding contract. | Intentionally dropped; no expanded account-wide authorization. |
| Group metadata / participant permission | Existing bound `w:g2` query, synthetic group/Signal behavior and actor-owned pair/unpair. | Group Noise, IQ and ownership tests. Arbitrary group administration is not an advertised Clawdi surface; membership mutations need separate nested-target authorization review. |
| Restart / reconnect | One sidecar socket per session; API control pools do not acquire ingress ownership; durable aliases select PN/LID. | Pool/registry, Noise restoration, SQLite and native-consumer fixtures. Multi-host failover is not demonstrated. |
| Duplicate / cursor / outbox retry | Inbound provider-event uniqueness; retained outbox semantic-envelope/stanza-ID deduplication under a PostgreSQL lock; per-binding durable queue. | Concurrent bridge calls, post-commit replay through actual delivery/HTTP, proto/edit/poll-envelope conflicts, Link/account scope and same-target edits. No guarantee after record retention or exactly-once physical delivery; historical duplicates require separate review. |
| Archive, unlink, revocation | Account archive confirms physical logout; Link archive withdraws that Link's synthetic auth/routing; chat unpair is actor-scoped. | Onboarding, channel, Noise revocation and CLI projection tests. Do not infer why a historical user unlinked. |
| Public/private tenant isolation | Account, Link, binding and alias authority checked before provider calls. | Existing cross-user, cross-Link, stale-revision and revoked-authority tests; Custom opaque session fixture. |
| Calls, status, broadcast, history sync | Not exposed as the supported chat product surface. | No mobile-app parity claim; do not broaden JID/node policy from redacted event counts. |
| Hosted native process / Files / UI | Hosted component admission is independent, based on fresh component-specific proof. | Hosted `backend-components` and `infra-runtime-bootstrap`; no container restart or fleet migration in this task. |

### Reproduction and remaining acceptance

```bash
bash scripts/test.sh backend tests/test_whatsapp_provider_bridge.py \
  tests/test_whatsapp_native_transport.py tests/test_whatsapp_sidecar_registry.py \
  tests/test_whatsapp_baileys.py tests/test_whatsapp_noise.py \
  tests/test_whatsapp_custom_onboarding.py tests/test_whatsapp_managed_onboarding.py \
  tests/test_channel_debug_events.py tests/test_channels.py tests/test_channel_inbox.py
bash scripts/test.sh sidecar
bash scripts/test.sh cli
bash scripts/test.sh web src/hosted/v2/channels
bash scripts/test-managed-whatsapp-native-e2e.sh
```

Validation on 2026-09-13: backend target set 630 passed; sidecar 82 passed
with typecheck; CLI all 156 test files passed with typecheck; Web channel tests,
typecheck, OSS build and 9 production SSR checks passed. Changed production
Python passes Ruff lint/format and BasedPyright (zero errors/warnings). Hosted
component and bootstrap suites pass, including 51 PostgreSQL checks.

The fixed-artifact OpenClaw and Hermes E2Es pass with the strict read-receipt
assertion and controlled restart checks. The latest run also covers a native
Hermes edit and passes two required PostgreSQL capture-to-outbox tests, one per
consumer. The prior read-receipt HTTP 500 is absent.
Hermes' fixture interpreter reports an upstream SQLite safety fallback to DELETE
journal mode; this is not physical-sidecar or production durability evidence.

The normal sidecar suite includes the native HTTP/proto fixture; it is not an
optional test. The stock-consumer E2E uses an isolated Noise harness. Its required final stage
captures fresh decoded OpenClaw/Hermes envelopes, including native polls and a
Hermes edit, and passes them through the real bridge/outbox in the official
PostgreSQL runner. This is an artifact handoff, not a shared live WebSocket/DB
identity session or a physical-provider delivery drill. Identical-semantic replays
retain the original receipt; changed edit/poll metadata must return conflicts
without additional Message/Delivery rows. The explicit E2E module requires capture
input and never skips when it is missing; `client-ci.yml` gates this stage through
`scripts/test-managed-whatsapp-native-e2e.sh`. Ordinary backend tests remain a
separate regression gate; SQLite/native socket checks cover the physical adapter
boundary. The native
fixture now requires actual `receipt type=read`, not any receipt: delivery
receipts previously let the read-receipt assertion pass despite a missing
privacy response. Its explicit privacy fixture follows the pinned SDK query.
The image normalizes root-owned source readability for private worktrees and
bounds each offline consumer container; these are test-infrastructure changes,
not production permissions or resource policy.

Done: all commands exit zero and the review records their actual counts and
pinned versions. Live acceptance remains a separate root-orchestrator action:
use an explicitly approved disposable account and consenting recipient; verify
QR/code/cancel/re-pair, text/quote/mention, each media type, consumer-supported
reactions/edit, read/typing and group metadata; restart one API worker and the
sidecar separately; verify reconnect, retry IDs and no cross-Link delivery;
revoke the Link, then separately archive the account and confirm logout.
Record physical observations without credentials or message contents. A
successful offline fixture is not approval to perform this drill.


## Scope and evidence

This audit uses the latest stable releases published on the audit date:

- OpenClaw `v2026.7.1`, release commit
  [`2d2ddc43`](https://github.com/openclaw/openclaw/tree/2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4),
  with `baileys@7.0.0-rc13` pinned by the WhatsApp extension.
- Hermes `v2026.7.30`, release commit
  [`cc4cab2f`](https://github.com/NousResearch/hermes-agent/tree/cc4cab2f592e60a197e796506de9168f74baf3ea),
  with `@whiskeysockets/baileys@7.0.0-rc13` pinned by its bridge.
- Both npm artifact names resolve to Baileys source commit
  [`8053b086`](https://github.com/WhiskeySockets/Baileys/tree/8053b086ecc97ec3f78299561de11959bab05d39).

The matrix uses `A` for behavior explicitly implemented by the stock consumer,
`B` for an exact proto/BinaryNode behavior Baileys naturally carries without a
consumer-specific translation, and `C` for behavior the stock consumer does
not surface or deliberately ignores. `A+B` means the consumer invokes Baileys
and Baileys supplies the wire encoding, encryption, upload, or retry behavior.

## Capability and call-path matrix

| Capability | OpenClaw stock | Hermes stock | Managed transport result |
| --- | --- | --- | --- |
| Inbound/outbound text | `A+B` both directions | `A+B` both directions | Exact `proto.Message` bytes cross the provider bridge; no text adapter is needed. |
| Media upload/send | `A+B`: image, audio/voice, video/GIF, document and force-document | `A+B`: image, video/GIF, audio/voice and document | Baileys encrypts/uploads media, then the exact media proto is relayed. The exact rc13 `w:m/media_conn` provider-service IQ is authorized; media bytes do not pass through FastAPI or the sidecar. |
| Media receive/download | `A+B`: image, video, audio, document, sticker; streamed with a default 50 MiB consumer limit | `A+B`: image, video, audio/PTT, document and sticker | Exact inbound media proto lets the stock consumer use Baileys download/decrypt. Clawdi does not buffer or proxy the media body. |
| Reactions | `A+B` outbound add/remove; `C` normal inbound reactions (approval reactions are handled specially) | `A+B` inbound normalization; `C` outbound | Reaction proto is transparent. Consumer behavior, not Clawdi translation, determines what the Agent sees. |
| Typing/presence | `A+B` composing and available/unavailable | `A+B` composing; no explicit stop API call | Chat-scoped `chatstate` is ownership-rewritten and relayed. Global presence has no chat target and remains fail-closed pending a separate identity-safe contract. |
| Read receipts | `A+B`, including group participant and self-chat policy | `A+B`, opt-in after policy acceptance, preserving participant | Exact rc13 privacy IQ plus ownership-checked receipt BinaryNodes are relayed. Physical delivery/read status is not replayed as an application event. |
| Replies/quoted messages | `A+B` inbound and outbound | `A+B` inbound and outbound | Quote/contextInfo remains inside exact proto bytes. |
| Groups/participants/LID/PN | `A+B`: metadata/cache, participant and LID/PN mapping | `A+B`: metadata, participant and LID/PN/self-chat handling | Binding aliases and Link ownership choose the physical chat; group proto and addressing attributes remain intact. Broad participant/device-identity nodes are never forwarded from the synthetic stanza. |
| Reconnect/retry/getMessage/IDs | `A+B`: reconnect, send retry and a 10-minute exact-proto `getMessage` cache | `A+B`: reconnect, bounded 512-message store/dedupe; placeholder `getMessage` response | Synthetic reconnect remains stock behavior. The physical sidecar owns reconnect and durable exact-proto retry state. Inbound provider-event uniqueness rejects duplicates. The current review above qualifies outbox deduplication by retained rows and operation identity; the original audit did not prove ACK-loss safety. |
| Polls | `A+B` outbound | `A+B` outbound and inbound vote aggregation | Poll proto is transparent. rc13 additionally requires one exact `meta polltype=creation` node; only that bounded node is preserved. |
| Edits/deletes | `C` edit/delete | `A+B` outbound edit; `C` delete and inbound edit/delete | Existing additional message attributes preserve Hermes edit. No unsupported consumer feature is invented. |
| Location | `A+B` inbound/outbound | `A+B` inbound/outbound, including inbound live location | Exact proto only. |
| Contacts | `A+B` inbound/outbound | `A` inbound; `C` outbound | Exact proto only. |
| Stickers | `A+B` inbound/outbound | `A` inbound; `C` outbound | Exact proto only. |
| Voice notes | `A+B` inbound/outbound PTT | `A+B` inbound/outbound Ogg/Opus PTT | Exact media proto plus the media upload/download paths above. |
| Link previews | `B`: generated by Baileys for stock text send | `B`: generated by Baileys for stock text send | Embedded preview proto is relayed without interpretation. |
| Unknown/wrapped types | `A` unwraps ephemeral/view-once; unknown types are ignored safely | `A` normalizes known wrappers/types; unknown types are ignored safely | Unknown proto fields remain in the bytes. No backend decoder rewrites them. |
| Receipts/acks | `B` Baileys transport ACKs; consumer does not expose physical delivery status as Agent content | `B` Baileys transport ACKs; no general delivery-status application surface | Synthetic protocol ACKs are terminated locally. Physical receipt/ACK replay is a real unsupported boundary, not an application translation task. |
| Trusted-contact privacy tokens | `B`: rc13 issues them after normal 1:1 sends and catches failures | `B`: same pinned rc13 behavior | The account-scoped `privacy/tokens` IQ contains nested contact JIDs and remains fail-closed. rc13 treats failure as non-fatal, so the message send still completes. This is a real unsupported protocol operation, not an untested application payload. |

## Official source call paths

OpenClaw creates its stock socket and retry cache in
[`session.ts`](https://github.com/openclaw/openclaw/blob/2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4/extensions/whatsapp/src/session.ts#L157-L223),
implements send/media/reaction/read operations in
[`send-api.ts`](https://github.com/openclaw/openclaw/blob/2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4/extensions/whatsapp/src/inbound/send-api.ts#L120-L283)
and
[`send.ts`](https://github.com/openclaw/openclaw/blob/2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4/extensions/whatsapp/src/send.ts#L121-L393),
and consumes inbound proto/media/group/reply shapes in
[`monitor.ts`](https://github.com/openclaw/openclaw/blob/2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4/extensions/whatsapp/src/inbound/monitor.ts#L970-L1402),
[`monitor.ts`](https://github.com/openclaw/openclaw/blob/2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4/extensions/whatsapp/src/inbound/monitor.ts#L1549-L1838),
and
[`media.ts`](https://github.com/openclaw/openclaw/blob/2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4/extensions/whatsapp/src/inbound/media.ts#L21-L89).

Hermes owns its stock socket, reconnect, `getMessage`, send/edit/media/poll and
inbound event handling in
[`bridge.js`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/scripts/whatsapp-bridge/bridge.js#L396-L773)
and
[`bridge.js`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/scripts/whatsapp-bridge/bridge.js#L820-L1109),
normalizes quoted/native media/reaction/location/contact/poll shapes in
[`bridge_helpers.js`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/scripts/whatsapp-bridge/bridge_helpers.js#L299-L507),
and exposes those stock capabilities through
[`adapter.py`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/plugins/platforms/whatsapp/adapter.py#L853-L1225)
and
[`adapter.py`](https://github.com/NousResearch/hermes-agent/blob/cc4cab2f592e60a197e796506de9168f74baf3ea/plugins/platforms/whatsapp/adapter.py#L1379-L1576).

Baileys rc13 generates message/media/reaction/quote content in
[`messages.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/messages.ts#L124-L270)
and
[`messages.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/messages.ts#L395-L770),
streams/decrypts media in
[`messages.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/messages.ts#L1044-L1107),
queries `w:m/media_conn`, sends receipts, and relays exact proto/options in
[`messages-send.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/messages-send.ts#L126-L233),
[`messages-send.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/messages-send.ts#L616-L1152),
and
[`messages-send.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/messages-send.ts#L1328-L1408).
The exact read-receipt privacy query is in
[`chats.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/chats.ts#L146-L156),
while rc13's fire-and-forget failure handling and exact trusted-contact token
query are in
[`messages-send.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/messages-send.ts#L1098-L1142)
and
[`messages-send.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/messages-send.ts#L1218-L1244).
Baileys rc13 constructs the exact device/LID USync query in
[`socket.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/socket.ts#L264-L318)
and uses it for recipient device resolution in
[`messages-send.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Socket/messages-send.ts#L303-L327).
Its inbound decoder stores the PN/LID mapping and selects the actual Signal
decryption JID in
[`decode-wa-message.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/decode-wa-message.ts#L22-L50)
and
[`decode-wa-message.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/decode-wa-message.ts#L306-L330).
Noise certificate signatures follow rc13's X25519-key verification in
[`noise-handler.ts`](https://github.com/WhiskeySockets/Baileys/blob/8053b086ecc97ec3f78299561de11959bab05d39/src/Utils/noise-handler.ts#L189-L222)
and use only python-xeddsa `1.2.0`'s published exports and signing API in
[`__init__.py`](https://github.com/Syndace/python-xeddsa/blob/c7b161a55e8e98d38c79f32116cc4681c805897d/xeddsa/__init__.py#L3-L27)
and
[`bindings.py`](https://github.com/Syndace/python-xeddsa/blob/c7b161a55e8e98d38c79f32116cc4681c805897d/xeddsa/bindings.py#L285-L312).

## Clawdi boundary and concrete gaps

The managed endpoint is not an end-to-end encrypted Noise byte tunnel.
FastAPI terminates the Link-scoped synthetic Noise/Signal session, authorizes
the Link/account/chat, then preserves the decrypted exact `proto.Message`
bytes through the durable outbox and the physical sidecar's `relayMessage`.
Inbound `messages.upsert` proto bytes take the reverse path. Presence,
chatstate, receipts and bounded IQs remain raw BinaryNodes after ownership
policy.

Three concrete envelope gaps were found and fixed without an application adapter:

1. rc13 media upload and read-receipt policy use account-scoped provider IQs,
   not chat JIDs. The former chat-only check rejected them. Only the exact
   `iq set w:m to=s.whatsapp.net / media_conn` and
   `iq get privacy to=s.whatsapp.net / privacy` shapes now bypass chat binding;
   active Link/account authority still applies and every extra/wrong field,
   target, child, type or namespace fails closed.
2. Poll creation uses exact proto plus an additional
   `<meta polltype="creation"/>` child. The former bridge kept proto and message
   attributes but dropped that child. The durable/provider/sidecar envelope now
   accepts only this one exact node. Participants, encrypted payloads,
   device-identity, event metadata and arbitrary raw nodes are rejected or not
   forwarded.
3. rc13's recipient device/LID USync targets are nested inside the IQ content,
   so the former top-level JID authorization could not forward the stock query.
   The bridge now accepts only the exact rc13 query shape, requires every target
   to resolve to an active binding owned by the calling Link, and queries the
   one physical provider transport. If that query is unavailable, it may return
   only a PN/LID pair already observed in that same binding's durable aliases;
   missing, ambiguous, cross-Link, or same-number inferred aliases fail closed.
   For inbound PN-primary envelopes with a real LID alternate, Signal state is
   stored under rc13's LID decryption address without fabricating a LID or
   mirroring the session under a second address.

Global available/unavailable presence, trusted-contact token IQs, live group
event projection, and physical delivery/receipt replay remain real unsupported
boundaries. The remaining `A+B` rows are supported by pinned consumer/rc13
source call paths, deterministic exact-proto/envelope tests, and the CI-wired
fixed-artifact stock OpenClaw/Hermes native-plugin E2E. A real-account message
drill has not been executed. That is release evidence to collect, not a runtime
feature flag or a known translation gap.
