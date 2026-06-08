# Msg Router Parity Matrix

This matrix treats `/home/kingsley/msg-router` as the source specification for
the Clawdi-native Python/FastAPI migration. Status meanings:

- `Implemented`: equivalent product behavior has backend implementation and
  Python test coverage.
- `Partial`: a meaningful slice exists, but old behavior or tests are not yet
  equivalent.
- `Pending`: product-relevant behavior is not migrated yet.
- `Superseded`: old behavior is replaced by an existing Clawdi-native product
  concept; no compatibility route or old infrastructure should be recreated.

## Current Verdict

The migration has product-level parity with the old `msg-router` channel
surface. It is not a line-for-line recreation of the old Node process: legacy
adapter/router/admin process structure, old root compatibility routes, real
grammY/discord.js process tests, and mux-super utility behavior are
intentionally superseded by provider-prefixed FastAPI routes, Clawdi auth,
agent-scoped channel links, SQLAlchemy state, and Clawdi-owned workers. The backend now has
the
Clawdi-native channel control plane plus expanded Telegram, Discord,
iMessage/BlueBubbles, WhatsApp, private-IP guard, metrics/auth, Telegram
webhook redelivery, shared rate-limiter, pairing-flow, and BlueBubbles
payload/error-envelope/Socket.IO/webhook-auth/chat-new parity slices, Discord fixture replay,
Discord command scope/fan-out, Telegram `/start <pair-code>` deep-link pairing,
core inbox/migration/debug endpoints, credential lifecycle endpoints, and shared worker lifecycle coverage,
WhatsApp Signal/group state helpers, WhatsApp Noise runtime debug events,
credential-backed WhatsApp prekey bundle reuse on reconnect, and a Python-native
WhatsApp inbox pump contract plus route-level durable inbox delivery into the
Baileys websocket, session-level inbound push with Baileys-compatible random
padding, direct delivered-at ack, prekey consumption persistence, outbound DM
Signal decrypt/proto extraction, outbound group SKDM/SKMSG decrypt/proto
extraction, and minimal WhatsApp text proto encoding, tenant-scoped DM Signal
sender snapshot restore, plus outbound message ack/error-close handling and
group sender-key snapshot restore,
and decoded WhatsApp text/reply/Cloud-link image/audio outbound enqueue through a
Python-native transparent shared-bot runtime seam into the Clawdi delivery
outbox, private-chat encrypted image/audio media reupload through Graph media IDs,
Cloud-native raw relay for WhatsApp read receipts and typing indicators,
and a route-wired native-transport registry/status surface plus a Baileys
sidecar client contract and workspace sidecar package for Baileys-only proto,
Baileys 7 packed WABinary token/JID decode with a generated full token table,
plus cross-provider chat isolation coverage.
As of this audit, the matrix has 128 Implemented, 0 Partial, 0 Pending, and
24 Superseded rows. Backend tests pass at
`671 passed, 7 skipped, 13 warnings in 46.66s` by default. The opt-in
blackbox channel E2E starts a real `uvicorn app.main:app` process and exercises
the provider-prefixed FastAPI HTTP and Discord WebSocket surfaces with
`CLAWDI_RUN_CHANNELS_BLACKBOX_E2E=1 uv run pytest -q tests/e2e/test_channels_blackbox.py --maxfail=1`
at `1 passed in 5.22s`. The opt-in Node
Baileys smoke reports sidecar-to-FastAPI open in this local environment with
`CLAWDI_RUN_BAILEYS_SMOKE=1 CLAWDI_BAILEYS_SMOKE_CWD=/home/kingsley/.paseo/worktrees/2hybfhpy/feat-channels-msg-router-runtime uv run pytest -q tests/test_whatsapp_baileys_smoke.py --maxfail=1`
at `1 passed, 5 skipped, 3 warnings in 2.08s`; real linked-account smoke remains
a deployment acceptance gate.
including the new BlueBubbles envelope, cross-provider isolation, and WhatsApp
runtime debug event, prekey bundle reconnect, websocket inbox pump, inbound
push, direct ack, outbound DM/group decrypt/proto callback, and outbound
message ack plus malformed websocket close/debug, text proto encoder,
Baileys packed WABinary decode, real Baileys open/inbox/fixture-shape smoke, and
signal/group sender-key snapshot restore, structured shared-runtime outbox adapter,
encrypted media reupload, native transport adapter and sidecar-contract health, and
websocket outbound queue tests. The new
`packages/whatsapp-baileys-sidecar` package passes Biome, TypeScript
typecheck, and 9 Bun unit tests for its HTTP/runtime contract. The backend
sidecar registry has focused pytest coverage for configuration parsing,
registration, shutdown cleanup, and unhealthy sidecar visibility, and the
opt-in smoke starts the sidecar against the FastAPI Baileys runtime. A live
WhatsApp linked-account sidecar smoke remains a deployment acceptance gate,
not a Python/FastAPI migration gap.

## Completion Plan

All migration batches are closed for code parity. The only remaining gate is
environmental: run the Baileys sidecar against a real linked WhatsApp account
in deployment before claiming production upstream connectivity.

## PR Readiness

The branch is ready for a code-review PR. The PR should not claim that every
secret-backed live provider path was exercised in the test deployment: the
current local machine can reach the public test msg-router and Phala status API,
and a recovered old admin token was sufficient for admin-plane parity probing,
but SSH into the test CVM still fails because the runtime config has no
authorized keys and the complete sealed env file is not present locally. The
remaining deployment gate is a supervised smoke with real provider credentials
and a linked WhatsApp account.

Latest pre-PR verification:

- `uv run ruff check app tests alembic/versions/2d4c8e1b7a90_clawdi_native_channels.py`
  passes.
- `uv run pytest -q --durations=25 --durations-min=0.05` reports
  `667 passed, 7 skipped, 13 warnings in 39.63s`.
- `CLAWDI_RUN_CHANNELS_BLACKBOX_E2E=1 uv run pytest -q tests/e2e/test_channels_blackbox.py --maxfail=1`
  reports `1 passed in 5.29s`.
- `CLAWDI_RUN_BAILEYS_SMOKE=1 uv run pytest tests/test_whatsapp_baileys_smoke.py -q --maxfail=1`
  reports `6 passed, 8 warnings in 10.70s`.
- `bunx biome check packages/whatsapp-baileys-sidecar`,
  `bunx turbo typecheck --filter=@clawdi/whatsapp-baileys-sidecar`, and
  `bun test` in `packages/whatsapp-baileys-sidecar` pass.
- `uv run alembic heads` reports only `2d4c8e1b7a90 (head)`.
- No temporary/cache/process files are present in the PR tree.

Latest live test msg-router parity probe:

- The old test deployment accepted a recovered admin token and returned the
  expected `/health` SHA `44bbfd03b50730c089f84cbc2613c202585d8f2c`.
- A temporary tenant was created, used, and deleted with `204` cleanup.
- Tenant-plane `/v1/channels` started empty, then listed
  `discord,imessage,telegram,whatsapp` after credential minting.
- Telegram agent surface returned `getMe: ok=true` and
  `getUpdates: ok=true, result_len=0`.
- Discord agent surface returned `/api/v10/gateway/bot` with a gateway URL and
  `/api/v10/users/@me` with `bot=true`.
- BlueBubbles `GET /api/v1/server/info` authenticated with the iMessage agent
  token and returned `private_api=true` with
  `msg-router-bluebubbles-emu`.
- WhatsApp tenant credentials included a JID and auth cert, and
  `/admin/whatsapp/cert` returned a public key.
- The equivalent focused FastAPI parity subset passed:
  `13 passed in 1.46s`.

| Batch | Status | Scope | Backend work | Test gate | Delivery gate |
| --- | --- | --- | --- | --- | --- |
| W0 | Done | Full old `src/` + `tests/` inventory | Matrix covers every old product module and test helper; unknown rows are not allowed. | `git -C /home/kingsley/msg-router ls-files src tests` reports 152 tracked old files and this matrix covers 152/152. | Required before any PR. |
| W1 | Done | Provider-prefixed FastAPI migration | Telegram, Discord, iMessage/BlueBubbles, core/shared, and WhatsApp Cloud/Baileys boundary behavior live under `/api/channels/{provider}/*`; old root compatibility routes stay absent. | Full pytest + route-audit tests. | Independently deployable. |
| W2 | Done | WhatsApp Baileys agent websocket | Python Noise/WABinary/Signal/group sender-key/inbox/outbound callback path reaches real Baileys `connection: open` and `messages.upsert`. | `CLAWDI_RUN_BAILEYS_SMOKE=1 uv run pytest tests/test_whatsapp_baileys_smoke.py -q --maxfail=1`. | Independently deployable behind existing channel account controls. |
| W3 | Done | Shared runtime Cloud-safe outbound | Text, quoted replies, public-link image/audio, read receipts, and typing indicators are translated to WhatsApp Cloud API without lossy Baileys attr degradation; remaining Baileys-only paths are explicit. | `test_whatsapp_baileys.py`, `test_whatsapp_noise.py`, `test_channels.py`. | Independently deployable; reduces need for raw upstream. |
| W4 | Done | Encrypted media reupload | For private-chat encrypted Baileys media where `mediaKey`/`directPath` are present, download from WhatsApp media CDN, derive WA media keys, decrypt/verify bytes, upload to Graph media endpoint, and send Cloud API media id through the existing delivery outbox. Plaintext media is not persisted. | WAProto candidate tests plus deterministic byte-level media crypto/reupload/delivery-worker tests; full pytest passes. | Deployable for Cloud-configured WhatsApp accounts; invalid media records safe debug failure without queueing provider sends. |
| W5 | Done | Baileys sidecar live upstream native transport | Backend adapter and health semantics are implemented: `WhatsAppNativeTransportAdapter` wraps a native runtime client behind `relay_outbound_message`, `relay_raw_node`, and `query_iq`, filters Baileys-managed attrs, and reports disconnected registered transports as unavailable. `WhatsAppBaileysSidecarClient` defines the internal HTTP contract and exposes `sidecar` health mode. `ConfiguredWhatsAppSidecarRegistry` wires configured sidecars into the FastAPI lifespan registry. `packages/whatsapp-baileys-sidecar` implements the minimal Baileys runtime package with bearer-authenticated health, proto relay, raw node send, IQ query, multi-file auth state, reconnect, and byte-safe node JSON. The opt-in smoke starts the sidecar and verifies it reaches `connected` against the FastAPI Baileys runtime. | Backend adapter/sidecar-contract/registry unit tests pass; sidecar Biome/typecheck/Bun tests pass; full pytest and opt-in Baileys smoke pass. | Production upstream readiness requires deployment-supervised linked-account smoke. |
| W6 | Done | Final product/ops closure | Route audit, stale marker search, migration matrix counters, full backend pytest, opt-in Baileys smoke, and docs update agree. Backend APIs cover provider tokens, webhooks, pair codes, bindings, debug health, and metrics. | `uv run ruff check app tests`; `uv run pytest -q --durations=25 --durations-min=0.05`; opt-in Baileys smoke. | PR-ready for code parity; linked-account smoke is a deployment gate. |

## Test Msg-Router Baseline

`clawdi-monorepo/infra/msg-router` defines the old test deployment used as the
runtime comparison baseline:

- test CVM: `da2d1abd4ab7f5f6b514af5fecbc4d44eb45de39`
- msg-router URL:
  `https://da2d1abd4ab7f5f6b514af5fecbc4d44eb45de39-18890.dstack-pha-prod3.phala.network`
- deployed msg-router image:
  `ghcr.io/clawdi-ai/msg-router:phala-44bbfd0@sha256:35d627be91f5240a9e32422876a7624f16c3146802cf7226f01f9f0e4cb9a153`
- deployed `/health` SHA: `44bbfd03b50730c089f84cbc2613c202585d8f2c`
- local old source HEAD: `44bbfd03b50730c089f84cbc2613c202585d8f2c`

No-secret checks against the test deployment passed:

- `phala ps da2d1abd4ab7f5f6b514af5fecbc4d44eb45de39` reports
  `msg-router`, `mux-server`, and `mux-proxy` running and healthy.
- `GET /health` on port `18890` returns the expected msg-router SHA.
- `GET /health` on port `18891` returns mux-server healthy.
- `GET /api/v10/gateway/bot` without an agent token returns `401`, confirming
  the Discord-compatible agent route is present and authenticated.
- `docker compose --env-file /dev/null -f infra/msg-router/docker-compose.yml
  config --quiet` passes with dummy test env, confirming the checked-in test
  compose shape still renders.

SSH access note:

- `phala runtime-config da2d1abd4ab7f5f6b514af5fecbc4d44eb45de39 --json`
  currently reports `ssh_authorized_keys: []`.
- Direct `phala ssh ... -- -i ~/.ssh/clawdi_access_ed25519` fails with
  `Permission denied (publickey)` from both the local machine and the
  `clawdi` ops host.
- A no-env redeploy with the same compose and `--ssh-pubkey
  ~/.ssh/clawdi_access_ed25519.pub` kept containers healthy but did not restore
  SSH keys for this existing CVM. The Phala CLI update path does not apply
  `--ssh-pubkey`; it only injects `DSTACK_AUTHORIZED_KEYS` during create.
- Do not repair this by sending a partial `DSTACK_AUTHORIZED_KEYS=...` env
  update: the msg-router README treats env updates as full sealed-env payloads,
  and the complete test env is not present on this machine or the `clawdi` ops
  host.

Field-level configuration mapping:

| Old test msg-router config | Clawdi-native backend equivalent |
| --- | --- |
| `ADMIN_TOKEN` and `/admin/*` bootstrap routes | Clawdi auth/admin + channel account APIs; old tenant bootstrap is superseded. |
| `DB_PATH=/data/msg-router.sqlite` | Postgres tables from `2d4c8e1b7a90_clawdi_native_channels.py`. |
| `TG_BASE_URL` | `channel_telegram_api_base_url`. |
| `DISCORD_BASE_URL` | `channel_discord_api_base_url`. |
| `DISCORD_GATEWAY_URL` | `channel_discord_gateway_url`. |
| `DISCORD_AGENT_GATEWAY_URL` | `/api/channels/discord/gateway` advertised through provider-prefixed REST. |
| `MSG_ROUTER_TELEGRAM_PROVIDER_TOKEN` / `MSG_ROUTER_DISCORD_PROVIDER_TOKEN` | Encrypted channel account provider token storage. |
| mux-super tenant/token env (`MSG_ROUTER_MUX_*`) | Superseded by Clawdi users, channel accounts, agent links, bindings, and the import route. |
| `WA_SHARED_BOT_AUTH_DIR` / `WA_SHARED_BOT_PHONE_NUMBER` | `ChannelAgentCredential`, auth cert storage, and configured Baileys sidecars. |
| `WA_WEBSOCKET_URL=ws://msg-router:18890/whatsapp` | `/api/channels/whatsapp/{account_id}/baileys`. |
| `IMESSAGE_DEFAULT_SERVER_URL` / `IMESSAGE_DEFAULT_API_KEY` | Encrypted BlueBubbles account config and provider-scoped auth. |
| `METRICS_*` | `metrics_bearer_token` / `metrics_basic_auth_*`. |

## Source Module Matrix

| Old source file | Status | Python target / product decision |
| --- | --- | --- |
| `src/channels/adapter.ts` | Superseded | Node `ChannelAdapter.start/stop` is replaced by provider-prefixed FastAPI routers, SQLAlchemy models/schemas, and `app.workers.channels` lifecycle services. |
| `src/channels/bluebubbles/auth.ts` | Implemented | `imessage_auth.py` keeps BlueBubbles auth provider-scoped and accepts the required auth shapes: `?password=`, `X-API-Key`, `X-Password`, and bearer tokens. |
| `src/channels/bluebubbles/message-sanitize.ts` | Implemented | `bluebubbles_compat.py` strips Photon `replyToGuid`/`replyGuid` while preserving true thread/tapback metadata such as `threadOriginatorGuid` and `associatedMessageGuid`; webhook delivery and HTTP query routes are covered. |
| `src/channels/bluebubbles/responses.ts` | Implemented | BlueBubbles success and error responses use `{status, message, data}` under `/api/channels/imessage/bluebubbles/*`; HTTPException and validation errors are converted without changing other provider error formats. |
| `src/channels/bluebubbles/router.ts` | Implemented | Route surface is present under `/api/channels/imessage/bluebubbles/v1/*`; auth, webhook registration, server info, address-based `chat/new`, initial-message creation, query/history/count/message ops, attachments, scheduling, extended compat routes, error envelopes, and ownership checks are covered. |
| `src/channels/bluebubbles/socket-io.ts` | Implemented | `bluebubbles_socket.py`, `imessage_realtime.py`; Socket.IO open/auth packets, missing/invalid `apiKey` rejection, and account-scoped fan-out are covered. |
| `src/channels/bluebubbles/webhook-emitter.ts` | Implemented | `channel_webhooks.py`, `imessage_realtime.py`; inbound webhook emission covers no-config no-op, 5xx retry, 4xx no-retry, private URL guard, encrypted delivery password storage, and `?password=` plus `x-password` delivery. |
| `src/channels/discord/channel-guild-map.ts` | Implemented | `ChannelBindingAlias` persists Discord `channel_id -> guild binding` mappings from webhook/gateway ingress, agent REST channel sends authorize through the alias, and Gateway GUILD_CREATE payloads synthesize known bound channels from aliases. |
| `src/channels/discord/commands.ts` | Implemented | Discord app-command shadow storage, application-id validation, global/guild lifecycle, reserved `/bot_*` rejection, duplicate-name upsert/conflict checks, bound-guild scope validation, and provider fan-out to uncontested bound guilds are covered through FastAPI tests. |
| `src/channels/discord/creds-store.ts` | Implemented | `channel_bot_agent_links.agent_token_hash`; raw token one-time issuance and rotation are covered by tests. |
| `src/channels/discord/egress-rest.ts` | Implemented | `channel_routers/discord.py`; Gateway discovery, bot/app profile shadows, app-command lifecycle, interactions/followups, message edit/delete, bound channel/guild REST proxy, DM-create rejection, unknown-path 403, and no old mux-super REST are covered. |
| `src/channels/discord/egress-ws.ts` | Implemented | `channel_routers/discord.py`; Gateway HELLO/heartbeat/READY/GUILD_CREATE, unsupported query rejection, zlib-stream outbound compression, Resume session validation, buffered dispatch replay, and old-sequence Invalid Session behavior are covered. |
| `src/channels/discord/ingress.ts` | Implemented | `discord_gateway_worker.py`, `record_discord_gateway_dispatch`; gateway dispatch routing, pairing, alias persistence, interaction token references, and fixture replay contracts are covered. |
| `src/channels/discord/interactions.ts` | Implemented | `channel_agent_references` persists interaction id/token and token/application ownership for callbacks and followups. |
| `src/channels/discord/pairing-handler.ts` | Implemented | Pair/unpair interaction handling covered in `test_channels.py`. |
| `src/channels/discord/rate-limiter.ts` | Implemented | `discord_rate_limiter.py`; route-key normalization, major-parameter buckets, webhook token templating, upstream header observation, local in-flight consume, 429 retry-after, and global limiter behavior are covered with deterministic-clock tests. |
| `src/channels/discord/routing.ts` | Implemented | `discord_chat_from_payload`, `discord_channel_scope_from_payload`, and `extract_discord_routing_key` now match old guild-scoped routing: guild events bind on `guild_id`, DMs bind on `channel_id`, thread/channel ids remain available as aliases, and guild-scoped no-channel events route by guild. |
| `src/channels/imessage/api.ts` | Implemented | Photon SDK process calls are replaced by Clawdi-native BlueBubbles-compatible routes and local persistence contracts; old direct SDK process semantics are not recreated. |
| `src/channels/imessage/creds-store.ts` | Implemented | `channel_bot_agent_links.agent_token_hash`; direct tests cover one-time token response, hashed storage, negative token lookup, active-name idempotency, channel deletion, token invalidation, and remint. |
| `src/channels/imessage/ingress.ts` | Implemented | `imessage_realtime.py`, `channels.py`; webhook ingest, pairing, realtime Socket.IO fan-out, attachment metadata, catchup/history routes, and client payload sanitization are covered through Python tests. |
| `src/channels/imessage/routing.ts` | Implemented | `imessage_routing.py` ports route-key build/parse/session key/chat-type detection, direct service fallback synthesis, and concrete provider send target resolution; BlueBubbles text sends use any/iMessage/SMS binding variants. |
| `src/channels/telegram/callback-refs.ts` | Implemented | `channel_agent_references` records inbound callback IDs and gates `answerCallbackQuery`. |
| `src/channels/telegram/commands.ts` | Implemented | Bot API command shadow storage, language/scope keys, chat-scope checks, delete semantics, default/private/group/admin broad-scope per-chat provider fan-out, and group/admin scope synthesis are covered through FastAPI tests. |
| `src/channels/telegram/creds-store.ts` | Implemented | `channel_bot_agent_links.agent_token_hash`; raw token one-time issuance covered. |
| `src/channels/telegram/egress.ts` | Implemented | `channel_routers/telegram.py`; provider-backed `getMe`, profile shadow, command shadow/fan-out, generic bound-chat Bot API proxy, multipart referenced-chat checks and attach-ref rewrite, private webhook target rejection, callback answer, `getFile`, file download proxy, send-method rate limits, and `getUpdates(timeout=...)` long-poll wait are covered. |
| `src/channels/telegram/file-refs.ts` | Implemented | `channel_agent_references` records file IDs/file paths and gates `getFile` plus `/api/channels/telegram/file/bot/*` downloads. |
| `src/channels/telegram/ingress.ts` | Implemented | Telegram webhook ingest, pair/unpair, `/start <pair-code>` deep-link pairing, callback query chat extraction, file/callback reference recording, synthesized `bot_command` entities, `deleteWebhook(drop_pending_updates=true)`, long-poll queueing, and webhook redelivery worker semantics are covered. |
| `src/channels/telegram/pairing-handler.ts` | Implemented | Shared `parse_pair_command` and webhook pairing tests cover product behavior. |
| `src/channels/telegram/routing.ts` | Implemented | `telegram_chat_from_update` ports the old routing matrix for message, edited message, channel post, callback query, Bot API 7.x business updates, membership, boost, reaction, and unsupported update handling. |
| `src/channels/whatsapp/agent-bundle.ts` | Implemented | `parse_agent_bundle` exists with focused tests. |
| `src/channels/whatsapp/auth-cert-store.ts` | Implemented | `load_or_create_whatsapp_auth_cert` persists stable certs with tests. |
| `src/channels/whatsapp/authorization.ts` | Implemented | `decide_whatsapp_relay` covers allowlist, JID bounds, spoof attr scrubbing, group receipt batch validation, strict batch shape, depth/width DoS caps, recipient checks, LID/PN cross-agent-link conflict drops, and safe JID log descriptions; old bridge/super-tenant bypass is not recreated. |
| `src/channels/whatsapp/bootstrap.ts` | Implemented | `WhatsAppNoiseEmulatorSession` emits `<success>` and `<offline>` after Noise completion, answers IQ, captures uploaded encrypt/prekey bundles, persists the bundle through the credential record, restores the stored bundle/preKey count on reconnect, and reaches real Baileys `connection: open` through the provider-prefixed FastAPI websocket. |
| `src/channels/whatsapp/creds-store.ts` | Implemented | `ChannelAgentCredential` and encrypted credential storage exist with metadata listing, identity lookup, revoke, channel-delete revoke, remint, shared self identity, auth cert tests, and Signal/group sender-key state helpers. |
| `src/channels/whatsapp/debug.ts` | Implemented | Generic channel debug event storage, sanitized event listing, and health summaries exist under `/api/channels/debug/*`; `WhatsAppNoiseEmulatorSession` now emits typed runtime events for Noise intro/hello, tenant resolution, bootstrap, frame decode/decrypt failures, IQ answers/failures, raw outbound relay, and captured prekey bundles, and the provider-prefixed Baileys websocket route persists them as sanitized WhatsApp `agent` debug events with route-level tests. |
| `src/channels/whatsapp/egress-ws.ts` | Implemented | FastAPI websocket `/api/channels/whatsapp/{account_id}/baileys` exists with Noise, credential identity gating, bootstrap, Baileys 7 packed WABinary token/JID decode backed by the full generated Baileys token table, IQ response, route-level durable inbox pumping into fixture-compatible `proto.Message` bytes padded like Baileys `writeRandomPadMax16` and wrapped as Signal-encrypted `<message><enc>` frames, direct delivered-at ack, outbound DM and group `<message>` decrypt/proto callbacks plus ack/runtime events, raw relay/IQ forwarding hooks into `WhatsAppClawdiOutboxSharedBotRuntime`, Cloud-native raw relay for private-chat read receipts and typing indicators, structured outbound enqueue into Clawdi `ChannelDelivery` for conversation, quoted `extendedTextMessage`, Cloud-link image/audio payloads, private-chat encrypted image/audio media reupload through Graph media IDs, and route-wired registered native-transport routing for voice-note audio, group-only proto, relay-attr messages, or other remaining Baileys-only proto, credential-backed bundle, DM Signal sender snapshot reuse, group sender-key snapshot reuse, a Python-native inbox pump ack/retry/debug/LID contract, and real Baileys `connection: open` plus inbox/quoted/image/group `messages.upsert` smoke coverage. The minimal Clawdi-owned Baileys sidecar package, FastAPI registration path, and sidecar-to-FastAPI runtime smoke now exist; deployment-supervised real linked-account upstream smoke is the production acceptance gate. |
| `src/channels/whatsapp/emulator.ts` | Implemented | Python Noise/bootstrap/Baileys-open WABinary/IQ session, Signal-encrypted inbound message push frame construction with fixture-compatible proto encoding and Baileys padding, outbound DM decrypt/proto extraction, outbound group SKDM/SKMSG sender-key decrypt/proto extraction, skmsg-only group follow-up after sender-key restore, outbound message ack, raw relay, prekey bundle capture/persistence, synthetic Signal sender/session snapshots, sender-key paths, and inbox pump delivery contract exist and are covered by real Baileys open/inbox/fixture-shape smoke. |
| `src/channels/whatsapp/group-cipher.ts` | Implemented | `GroupCipherBackend` persists sender-key state across backend instances and decrypts sender-key messages in Python parity tests. |
| `src/channels/whatsapp/iq.ts` | Implemented | `respond_to_iq` covers count/key/digest/prekey uploads, passive/md ack, usync devices, group metadata including LID/PN aliases, forwarding allowlists for safe `get`/`set` namespaces, null-forward fallback, id restoration, and missing-id errors. |
| `src/channels/whatsapp/media-proxy.ts` | Implemented | Media proxy rewrite/range forwarding is covered. |
| `src/channels/whatsapp/noise-server.ts` | Implemented | Python Noise handshake/frame implementation, emulator session bootstrap/IQ, unknown identity rejection, uploaded bundle capture tests, and opt-in real Baileys `connection: open` smoke coverage exist. |
| `src/channels/whatsapp/pair-handler.ts` | Implemented | WhatsApp webhook pair/unpair tests cover core flow. |
| `src/channels/whatsapp/router-ingress.ts` | Implemented | Webhook ingress covers Cloud API HMAC, `fromMe` skip, common Baileys text wrappers, pair/unpair, LID alias routing, remembered-alias unpair, and cross-agent-link LID/PN conflict drops; live Baileys socket ingress is tracked under the websocket/runtime rows. |
| `src/channels/whatsapp/shared-bot-runtime.ts` | Implemented | Pure shared-runtime contracts for IQ id forwarding and outbound relay attr filtering are ported in `whatsapp_baileys.py`; the agent outbound relay now has a Python seam in `whatsapp_shared_runtime.py`, with a concrete `WhatsAppClawdiOutboxSharedBotRuntime` adapter that reloads the active account, translates Baileys `proto.Message` into validated Cloud API `providerPayload` for text, quoted replies, public-link images, public-link audio, and private-chat encrypted image/audio after in-memory WhatsApp media-key decrypt/verify plus Graph media upload, queues those through the Clawdi delivery outbox, relays private-chat read receipts and typing indicators through WhatsApp Cloud API, and refuses to degrade Baileys relay semantics into Cloud API when the stanza carries preserved attrs such as `edit`, `addressing_mode`, or `category`. Voice-note audio, group-only proto, relay-attr messages, and other Baileys-only proto route to a registered native transport when available; `whatsapp_native_transport.py` now provides the native-runtime adapter plus `WhatsAppBaileysSidecarClient` for a minimal Baileys sidecar HTTP contract while preserving Baileys additional attrs; `whatsapp_sidecar_registry.py` registers configured sidecars during FastAPI lifespan; `packages/whatsapp-baileys-sidecar` implements the Baileys protocol adapter; safe raw presence/chatstate/receipt nodes relay when Cloud API or a transport adapter can express them; safe IQs forward with id restoration/backpressure; sanitized debug events record precise reasons such as `media-reupload-required`, `audio-ptt-native-required`, `baileys-relay-attrs-required`, media reupload outcome details, and Cloud raw relay outcomes; `/api/channels/debug/health` exposes whether the transport is unavailable, disconnected, `in_process`, or `sidecar` and which relay capabilities it supports. `whatsapp_runtime_types.py` keeps the outbound DTO shared by Noise and runtime adapters without coupling either implementation to the other. Real linked-account upstream sidecar smoke is a deployment acceptance gate. |
| `src/channels/whatsapp/signal-sender.ts` | Implemented | Python `SignalSender` implements the libsignal subset used by msg-router: X3DH prekey session setup, Double Ratchet message chains, Whisper/PreKeyWhisper framing, stable identity, prekey consumption, pkmsg/msg envelope transitions, mirrored decryptable sessions, signed-prekey fallback, snapshot restore semantics, and real Baileys inbound decrypt coverage. |
| `src/channels/whatsapp/tenant-creds.ts` | Implemented | Tenant creds minting is covered. |
| `src/channels/whatsapp/tenant-registry.ts` | Implemented | Minted credential lookup by Noise static identity gates websocket sessions, carries credential id through tenant resolution, persists uploaded prekey bundles, DM Signal sender snapshots, and group sender-key snapshots into `ChannelAgentCredential.config`, restores the stored bundle, preKey count, sender snapshots, and group sender keys on reconnect, and supports real Baileys open/inbox lifecycle. |
| `src/channels/whatsapp/ws-server.ts` | Implemented | The old file only re-exported `egress-ws.ts`; Python uses the provider-prefixed FastAPI websocket route instead of a standalone Node server. Real Baileys reaches `connection: open` and receives DB inbox messages, malformed Noise/client frames close with 1011 and sanitized debug events, disconnects cancel the inbox pump, route delivery now uses the shared `WhatsAppInboxPump` retry/ack/backoff module, and focused tests cover continuous idle polling plus IQ inflight backpressure. |
| `src/core/admin.ts` | Superseded | Clawdi admin/user/project model supersedes tenant admin CRUD; product-relevant msg-router import and debug event surfaces are migrated under `/api/channels/*`; old manual shared-bot/admin utilities are not recreated. |
| `src/core/api.ts` | Superseded | Tenant `/v1` control plane is replaced by `/api/channels` with Clawdi auth, channel accounts, and agent links. |
| `src/core/auth.ts` | Superseded | API-key tenant auth is replaced by Clawdi auth and hashed channel agent tokens. |
| `src/core/bindings.ts` | Implemented | `channel_bindings` and aliases exist with tests. |
| `src/core/bot-profile.ts` | Implemented | Telegram profile shadow and Discord `/users/@me` plus `/applications/@me` account-scoped profile shadow are covered. |
| `src/core/db.ts` | Superseded | SQLite schema is replaced by Postgres + Alembic. |
| `src/core/debug-events.ts` | Implemented | `channel_debug_events` stores sanitized account-scoped debug rows; `/api/channels/debug/events` filters them and `/api/channels/debug/health` reports pending inbox, last event, and last error. |
| `src/core/inbox.ts` | Implemented | `channel_messages.inbox_sequence` plus `dequeue/ack/drain/wait` service helpers cover monotonic cursors, account isolation, limits, Telegram update_id offset ack/drain, and DB-backed long-poll waits. |
| `src/core/migration.ts` | Implemented | `msg_router_migration.py` ports mux route-key translation, dump validation, Discord DM lookup, and Clawdi-native import to provider `ChannelAccount`/`ChannelBinding` rows via `/api/channels/migrations/msg-router/import-tenant`. |
| `src/core/pair-command.ts` | Implemented | `parse_pair_command` parity tests exist. |
| `src/core/pairing-flow.ts` | Implemented | Pair/unpair state machine is Clawdi-native in `resolve_inbound_binding`; one active binding is allowed per `(channel account, external chat)`, pairing can move that chat to a different bot-agent link only when sent by the external actor that owns the current binding, control commands are acked and not routed to agents, and Discord interaction replies use old canonical msg-router text. |
| `src/core/pairing.ts` | Implemented | `channel_pair_codes` lifecycle exists with tests. |
| `src/core/router.ts` | Implemented | Clawdi `main.py` and provider-prefixed channel routers replace the monolith; `app.workers.channels` starts outbound delivery, webhook redelivery, and Discord gateway workers. |
| `src/core/types.ts` | Superseded | SQLAlchemy/Pydantic models replace TypeScript types. |
| `src/env.ts` | Superseded | Pydantic settings replace env parsing; channel env parity needs config review. |
| `src/generated/bluebubbles-server-types.ts` | Superseded | Python schemas are local and narrower; route behavior remains the parity target. |
| `src/index.ts` | Implemented | `/health` and `/metrics` exist; old channel roots such as `/bot*`, `/api/v10/*`, `/api/v1/*`, `/channels/*`, `/socket.io/`, and `/media/*` are intentionally absent and covered by route-audit tests; channel worker stack lifecycle is covered. |
| `src/shared/http-face.ts` | Superseded | Hono middleware replaced by FastAPI dependencies. |
| `src/shared/json.ts` | Implemented | FastAPI route helpers parse GET query, JSON objects, form/multipart fields with wire-value coercion, and reject malformed JSON or non-object JSON bodies with focused route tests. |
| `src/shared/metrics-auth.ts` | Implemented | `metrics_auth.py` supports unauthenticated local mode, bearer auth, basic auth with default `prometheus` user, malformed basic rejection, and route auth tests. |
| `src/shared/metrics.ts` | Implemented | `metrics.py` exports the old Prometheus metric names/labels; route tests cover export/auth and integration tests cover inbound channel increments. Provider proxy/send/error/rate-limit/webhook delivery paths now update counters where the corresponding Python runtime exists. |
| `src/shared/private-ip.ts` | Implemented | `private_ip.py` covers literal private ranges, private hostname aliases/suffixes, IPv4-mapped IPv6, CGNAT, and DNS results; Telegram and BlueBubbles webhook registration use the shared guard. |
| `src/shared/rate-limiter.ts` | Implemented | `rate_limiter.py` ports the generic TokenBucket/RateLimiter semantics with deterministic clock tests; Telegram/Discord keep provider-specific limiters on top. |
| `src/shared/webhook-delivery.ts` | Implemented | Provider route config replaces the old webhook table: Telegram `setWebhook/getWebhookInfo/deleteWebhook` and BlueBubbles webhook register/list/delete are persisted on channel accounts; `channel_webhooks.py` covers URL guards, Telegram secret headers, delivery result metrics, and BlueBubbles retry semantics. |
| `src/shared/webhook-worker.ts` | Implemented | `ChannelWebhookDeliveryWorker` retries pending Telegram agent webhook inbox rows in order, acks on success, preserves failed rows for retry, drops TTL-expired rows, and is run by `app.workers.channels` alongside outbound delivery. |
| `src/types/libsignal.d.ts` | Superseded | TypeScript-only libsignal declarations are replaced by Python `SignalSender`/`GroupCipherBackend` contracts; no `.d.ts` surface exists in the FastAPI backend. |

## Test Matrix

| Old test file | Status | Python target / gap |
| --- | --- | --- |
| `tests/channels/bluebubbles/router.test.ts` | Implemented | Route surface, auth shapes, BlueBubbles error envelope, webhook self-registration/private URL guards, server/info private-api fields, address-based chat creation, initial-message creation, delivery retry/auth, payload sanitization, attachments, scheduling, extended compat routes, and ownership checks are covered in `test_channels.py`. |
| `tests/channels/bluebubbles/socket-io.test.ts` | Implemented | Socket.IO auth packet, invalid/missing token rejection, and account-scoped fan-out are covered. |
| `tests/channels/bluebubbles/webhook-emitter.test.ts` | Implemented | No-config no-op, 5xx retry, 4xx no-retry, private URL guard, encrypted password storage, and password query/header delivery are covered through inbound route/service tests. |
| `tests/channels/discord/commands.test.ts` | Implemented | Command shadow, global/guild create/edit/delete, reserved names, app-id validation, bound-guild scope validation, duplicate upsert/conflict behavior, and provider fan-out to uncontested guilds are covered. |
| `tests/channels/discord/egress-rest.test.ts` | Implemented | Gateway discovery, users, app command lifecycle, send basics, interaction callbacks/followups, message edit/delete proxy, bound-guild REST, DM-create rejection, and unknown-path 403 covered; old mux super-tenant REST is intentionally not recreated. |
| `tests/channels/discord/egress-ws.test.ts` | Implemented | Helper payloads, gateway replay, bound-guild discovery, alias-backed GUILD_CREATE channel synthesis, unsupported query rejection, zlib-stream compression, Resume valid/invalid session handling, replay buffer overflow, and fixture replay contracts are covered. |
| `tests/channels/discord/fixture-replay.ts` | Implemented | The old fixture helper itself is ported inline in `test_discord_fixture_replay.py`: fixture loading, WS frame filtering, REST pair reconstruction, multipart fixture detection, and multipart body rebuilding are covered. |
| `tests/channels/discord/fixture-replay.test.ts` | Implemented | `backend/tests/fixtures/discord` assets are migrated and `test_discord_fixture_replay.py` ports manifest loading, WS frame filtering, REST pairing, and multipart body reconstruction checks. |
| `tests/channels/discord/ingress.test.ts` | Implemented | Dispatch record/pairing, channel aliasing, gateway worker dispatch recording, and interaction token reference recording are covered. |
| `tests/channels/discord/interactions.test.ts` | Implemented | Interaction id/token and webhook followup ownership is covered through persistent `channel_agent_references`. |
| `tests/channels/discord/pairing.test.ts` | Implemented | Pair/unpair interactions covered. |
| `tests/channels/discord/rate-limiter.test.ts` | Implemented | `test_discord_rate_limiter.py` ports route-key, per-route bucket, 429, consume, and global limiter edge cases; `test_channels.py` keeps route-level 429 coverage. |
| `tests/channels/discord/routing.test.ts` | Implemented | `test_discord_routing.py` ports the old MESSAGE_CREATE, reaction, interaction, thread, guild-scoped event, READY/no-payload, and no-context cases. |
| `tests/channels/imessage/api.test.ts` | Implemented | BlueBubbles-compatible API tests cover the product surface; direct Photon SDK process semantics are superseded by FastAPI route/service contracts. |
| `tests/channels/imessage/creds-store.test.ts` | Implemented | `test_imessage_credentials.py` covers one-time token response, no readback leakage, hashed storage, valid/invalid lookup, active duplicate rejection, delete invalidation, binding/pair-code cleanup, and remint with a fresh token. |
| `tests/channels/imessage/ingress.test.ts` | Implemented | Webhook pair, realtime Socket.IO fan-out, catchup/history, attachment metadata, and client payload sanitization behavior are covered. |
| `tests/channels/imessage/routing.test.ts` | Implemented | `test_imessage_routing.py` ports the old route-key/helper matrix, and `test_channels.py` covers any-service binding resolution through the BlueBubbles send route. |
| `tests/channels/telegram/commands.test.ts` | Implemented | Tenant-local command shadow, language/scope isolation, delete semantics, chat-scope rejection, default fan-out, broad private fan-out, and group/admin scope synthesis are covered through FastAPI tests. |
| `tests/channels/telegram/egress.test.ts` | Implemented | Provider-backed `getMe`, profile shadow, command shadow/fan-out, generic bound-chat proxy, JSON and multipart referenced-chat rejection, attach-ref multipart rewrite, private webhook target rejection, callback ownership, `getFile`, file download scoping, send-method rate limits, and `getUpdates` long-poll wait/timeout are covered. |
| `tests/channels/telegram/ingress.test.ts` | Implemented | Webhook pair/unpair, `/start <pair-code>`, secret validation, callback query extraction, synthesized `bot_command` entities, file/callback reference recording, `deleteWebhook(drop_pending_updates=true)`, long-poll queueing, and webhook redelivery semantics are covered. |
| `tests/channels/telegram/pairing-handler.test.ts` | Implemented | Pair command parser, `/start <pair-code>` deep-link pairing, unknown `/start` pass-through, and webhook flows are covered. |
| `tests/channels/telegram/routing.test.ts` | Implemented | `test_telegram_routing.py` directly ports the old routing cases for messages, channel posts, callbacks, business updates, membership, boost, reaction, and unsupported updates. |
| `tests/channels/whatsapp/agent-bundle.test.ts` | Implemented | `parse_agent_bundle` test exists. |
| `tests/channels/whatsapp/authorization.test.ts` | Implemented | Relay allowlist, spoof scrub, group receipt batches, strict malformed receipt drops, DoS caps, recipient validation, JID log shape, and LID/PN conflict coverage exist; old mux-super bypass is intentionally absent. |
| `tests/channels/whatsapp/bootstrap.test.ts` | Implemented | Python Noise emulator session bootstrap tests cover `<success>`, `<offline>`, IQ responses, unknown identity rejection, uploaded bundle capture, credential persistence, reconnect preKey count restore, and opt-in real Baileys bootstrap/open conformance. |
| `tests/channels/whatsapp/creds-store.test.ts` | Implemented | Credential route, encrypted persistence, metadata listing, identity lookup, shared self identity, revoke, channel-delete revoke, remint, and Signal/group sender-key store edges are covered. |
| `tests/channels/whatsapp/e2e-bundle.test.ts` | Superseded | Old Baileys client e2e is replaced by Python Noise bundle-capture tests plus `parse_agent_bundle` coverage. |
| `tests/channels/whatsapp/e2e-inbound.test.ts` | Implemented | Old Baileys client decrypt e2e is covered by Python `SignalSender` pkmsg/msg session tests, `WhatsAppInboxPump` delivery-contract tests, and the opt-in real Baileys inbox smoke that asserts `messages.upsert` includes `remoteJid`, `id`, `pushName`, and `conversation`. |
| `tests/channels/whatsapp/e2e-minted-creds.test.ts` | Implemented | Minted creds JSON/auth-cert route behavior is covered by `test_whatsapp_tenant_creds_route_persists_auth_cert` and credential metadata tests. |
| `tests/channels/whatsapp/e2e-multi-tenant.test.ts` | Implemented | Multi-tenant isolation is covered by LID/PN conflict-drop tests and same-self-JID Noise identity credential resolution tests. |
| `tests/channels/whatsapp/e2e-open.test.ts` | Implemented | Old real Baileys `connection: open` assertion is covered by opt-in `tests/test_whatsapp_baileys_smoke.py`, while default CI keeps fast Python Noise handshake/bootstrap/open-contract coverage. |
| `tests/channels/whatsapp/e2e-outbound-group.test.ts` | Implemented | Group sender-key outbound semantics are covered by `GroupCipherBackend` persistence/decrypt tests. |
| `tests/channels/whatsapp/e2e-outbound.test.ts` | Implemented | Signal outbound semantics are covered by `SignalSender` session/snapshot/prekey/envelope tests plus relay-attr contract tests. |
| `tests/channels/whatsapp/e2e-tenant-resolution.test.ts` | Implemented | Tenant resolution by Noise identity, unknown identity rejection, same shared self-JID routing, credential revoke, and remint are covered in Python route/service tests. |
| `tests/channels/whatsapp/egress-ws-inbox-pump.test.ts` | Implemented | `WhatsAppInboxPump` covers delivery failure no-ack, transient retry, malformed-row ack-through, privacy-safe debug metadata, provider-LID/PN alternate preparation, `pushName`/timestamp preparation, and route-level websocket delivery through encrypted push and delivered-at ack. |
| `tests/channels/whatsapp/emulator.test.ts` | Implemented | Python emulator session covers Noise/bootstrap/minimal IQ, Baileys packed token/device-JID decode through the full generated token table, Signal-encrypted inbound push frame construction, outbound DM decrypt/proto callback, outbound group SKDM/SKMSG decrypt/proto callback, restored skmsg-only group follow-up, outbound message ack, raw relay eventing, runtime events, bundle persistence, reconnect preKey restore, sender snapshot restore, and group sender-key restore; service tests cover fixture-compatible text/quoted/image/group proto encoding and opt-in real Baileys open/inbox/fixture-shape smoke. |
| `tests/channels/whatsapp/group-cipher.test.ts` | Implemented | `GroupCipherBackend` sender-key persistence/decrypt parity is covered in `test_whatsapp_baileys.py`. |
| `tests/channels/whatsapp/iq.test.ts` | Implemented | Count/key/usync/group metadata, LID/PN aliases, safe forwarding allowlists, non-forwarded privacy namespaces, null fallback, id restoration, and missing-id errors are covered. |
| `tests/channels/whatsapp/media-proxy.test.ts` | Implemented | URL rewrite and Range proxy covered. |
| `tests/channels/whatsapp/noise-server.test.ts` | Implemented | Python in-process Noise, minimal WABinary, Baileys packed token/device-JID decode, emulator session bootstrap/IQ, Signal-encrypted inbound push frame construction, outbound message ack/error-close behavior, uploaded bundle capture/persistence, reconnect preKey count restore, unknown-identity rejection tests, and opt-in real Baileys open/inbox smoke exist. |
| `tests/channels/whatsapp/pair-handler.test.ts` | Implemented | WhatsApp webhook pair flow covered. |
| `tests/channels/whatsapp/router-ingress.test.ts` | Implemented | Webhook pair/unpair, HMAC, `fromMe`, wrapper text extraction, LID alias routing, remembered-alias unpair, unbound drops, and conflict-drop coverage exist; live Baileys socket ingress is tracked under websocket/runtime tests. |
| `tests/channels/whatsapp/shared-bot-runtime.test.ts` | Implemented | `test_whatsapp_baileys.py` ports pure `forwardIqOver`, `relayOutboundExtraAttrs`, WAProto-to-Cloud-payload helper contracts including image/audio fixture shapes, and encrypted image/audio reupload candidate parsing. `test_whatsapp_noise.py` now directly covers the `WhatsAppClawdiOutboxSharedBotRuntime` text/quoted reply queueing, encrypted media Graph reupload into delivery-worker media-id sends, encrypted media native-transport routing when a transport exists, Cloud-native read receipt and typing indicator relay, route-level registered native transport use for Baileys relay attrs, raw relay transport policy, IQ forwarding, and websocket-level outbound queueing. `test_whatsapp_native_transport.py` covers the native transport adapter, sidecar HTTP contract, outbound message attrs, raw nodes, IQ queries, disconnected health, and sidecar health mode. `test_whatsapp_sidecar_registry.py` covers sidecar config parsing, FastAPI registry wiring, unhealthy sidecar visibility, unregister, and client close. `test_whatsapp_baileys_smoke.py` now covers real Baileys open/inbox/fixture-shape smoke plus sidecar `connected` smoke against the FastAPI runtime. `test_channel_debug_events.py` covers native transport health visibility. `test_channels.py` covers delivery-worker use of structured WhatsApp `providerPayload` for text and audio plus invalid-payload failure handling. `packages/whatsapp-baileys-sidecar` has Bun tests for its bearer-authenticated HTTP contract, byte encoding, config parsing, disconnected mapping, proto relay, raw nodes, and IQ response encoding. Live deployment-supervised real linked-account sidecar smoke is a deployment acceptance gate. |
| `tests/channels/whatsapp/signal-sender.test.ts` | Implemented | `SignalSender` session/snapshot/prekey/envelope parity is covered in `test_whatsapp_baileys.py`. |
| `tests/channels/whatsapp/tenant-creds.test.ts` | Implemented | Tenant creds JSON and auth cert route tests exist. |
| `tests/core/admin.test.ts` | Superseded | Clawdi admin supersedes tenant CRUD; msg-router import and debug surfaces have Python route/service tests, while old manual shared-bot/admin utilities are not recreated. |
| `tests/core/api.test.ts` | Superseded | Old tenant `/v1` API replaced by `/api/channels`; control-plane tests exist in `test_channels.py`. |
| `tests/core/auth.test.ts` | Superseded | Old tenant API-key auth replaced by Clawdi auth and hashed channel tokens. |
| `tests/core/bindings.test.ts` | Implemented | Binding behavior covered through SQLAlchemy model/service tests. |
| `tests/core/db.test.ts` | Superseded | SQLite tests replaced by Alembic/Postgres coverage. |
| `tests/core/env.test.ts` | Superseded | Pydantic settings replace old env parser. |
| `tests/core/http-routing.test.ts` | Implemented | Old root channel routes are absent; prefix route audit was run. |
| `tests/core/inbox.test.ts` | Implemented | `test_channel_inbox.py` covers monotonic seq, account-scoped dequeue, cursor limits, ack-through-sequence, drain, Telegram update_id offset/filter draining, and DB-backed wait polling. |
| `tests/core/migration.test.ts` | Implemented | `test_msg_router_migration.py` ports route-key translation, dump validation, Discord DM lookup, Clawdi import route idempotency, and DM binding import. |
| `tests/core/pair-command.test.ts` | Implemented | Parser parity covered. |
| `tests/core/pairing-flow.test.ts` | Implemented | `test_channels.py` covers usage through provider webhooks/interactions, idempotent same-agent pairing, re-pairing a chat to another agent link, unpair/re-pair, channel isolation, and canonical replies. |
| `tests/core/pairing.test.ts` | Implemented | Pair code lifecycle covered. |
| `tests/core/router.test.ts` | Implemented | Main router includes provider-prefixed channel routers and route-audit tests verify legacy msg-router roots are absent; `test_channel_workers.py` covers delivery/webhook/Discord gateway worker stack. |
| `tests/e2e/telegram-grammy.e2e.test.ts` | Superseded | Real grammY process compatibility is replaced by FastAPI Bot API contract tests for `getUpdates`, `sendMessage`, `getMe`, webhook conflict, commands, files, callbacks, and `/start` deep-link pairing. |
| `tests/integration/commands-fan-out.test.ts` | Implemented | Telegram command fan-out is covered through provider-backed FastAPI tests for bound private/group/supergroup/unknown chats and broad private scope filtering. |
| `tests/integration/discord-scenarios.test.ts` | Superseded | Old Discord process replay is replaced by Python fixture replay helpers and provider-prefixed REST/Gateway/interaction route tests. |
| `tests/integration/discord.e2e.test.ts` | Superseded | Old minimal bot process e2e is replaced by FastAPI REST/Gateway/pairing/interaction contract tests. |
| `tests/integration/multi-tenant-isolation.test.ts` | Implemented | Core tenant isolation, provider-specific binding isolation, WhatsApp LID/PN conflict drops, same-self-JID Noise identity routing, and same external chat id across Telegram/Discord/iMessage/WhatsApp are covered through channel tests. |
| `tests/integration/webhook-redelivery.test.ts` | Implemented | `test_channels.py` covers Telegram webhook 5xx pending retention, worker redelivery/ack, TTL drop, and pair command control-message ack. |
| `tests/integration/whatsapp.enrollment-auth-cert.e2e.test.ts` | Implemented | Enrollment/auth-cert behavior is covered by minted credential route tests with stable auth cert reuse and channel-delete/revoke/remint coverage. |
| `tests/integration/whatsapp.fixture-conformance.test.ts` | Implemented | Captured Baileys protobuf replay is covered by Python WAProto byte-level tests plus opt-in real Baileys smoke cases for text inbox, quoted reply, image envelope, and group participant/sender-key distribution shape. |
| `tests/integration/whatsapp.multi-tenant-isolation.test.ts` | Implemented | Cross-tenant WhatsApp isolation is covered by LID/PN conflict-drop tests and same-self-JID Noise identity credential resolution tests. |
| `tests/shared/metrics-auth.test.ts` | Implemented | `test_metrics_auth.py` covers no-auth, bearer, basic, and malformed basic cases. |
| `tests/shared/metrics.test.ts` | Implemented | `test_metrics.py` covers metric export, counters, histogram, gauge, `/metrics` auth, and a real Telegram webhook inbound increment. |
| `tests/shared/private-ip.test.ts` | Implemented | `test_private_ip.py` ports the old literal/DNS matrix and route tests cover Telegram plus BlueBubbles DNS-private rejection. |
| `tests/shared/rate-limiter.test.ts` | Implemented | `test_rate_limiter.py` ports token bucket capacity, exhaustion, refill, capped refill, retry-after, per-key buckets, and invalid limit tests. |
| `tests/shared/webhook-delivery.test.ts` | Implemented | Route-level tests cover set/get/delete style config, private URL rejection/allowance, Telegram secret-header delivery, BlueBubbles 5xx retry, 4xx no-retry, and password query/header delivery behavior. |
| `tests/shared/webhook-worker.test.ts` | Implemented | `test_channels.py` covers ordered Telegram agent webhook redelivery through `ChannelWebhookDeliveryWorker`, success ack, failed attempt retention, and TTL drop. |
| `tests/helpers/db.ts` | Superseded | Old in-memory SQLite helper is replaced by pytest async SQLAlchemy fixtures in `tests/conftest.py`, matching the Clawdi backend's real DB dependency shape. |
| `tests/helpers/mock-tg.ts` | Superseded | Old Hono mock Bot API server is replaced by pytest monkeypatch/httpx fake clients at each Telegram boundary, while the Bot API behaviors it enabled are covered in Telegram route tests. |
| `tests/helpers/tenants.ts` | Superseded | Old tenant/channel provisioning helper is replaced by Clawdi-authenticated test client, agent, and channel account fixtures plus per-provider creation helpers in Python tests. |
| `tests/helpers/wa-events.ts` | Superseded | Old emulator event collector is replaced by direct assertions on Python runtime callbacks and persisted `channel_debug_events` rows. |
| `tests/integration/fake-openai-chat.ts` | Superseded | This helper served Hermes/OpenAI integration tests outside the channel router surface; it is not recreated in the msg-router channel migration. |

## Implementation Order

1. Build parity pytest helpers so provider cases can be ported without huge
   brittle test setup.
2. Complete Telegram first because it has the smallest SDK surface and old
   tests strongly define message/file/callback ownership semantics.
3. Complete Discord REST/Gateway next, including fixture scenario replay.
4. Complete iMessage/BlueBubbles edge cases while preserving the already
   migrated route surface.
5. Complete WhatsApp Baileys last because it requires protocol-grade WABinary
   and Signal/group sender-key work.
6. Revisit core/shared behavior after provider semantics are in place, keeping
   only product-relevant Clawdi-native surfaces.
