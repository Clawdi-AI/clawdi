# Channels Native Backend Migration

This branch replaces the `msg-router` wrapper plan with a Clawdi-native backend
module. The backend owns channel data directly in Postgres and exposes new
Clawdi routes plus Python-native channel-emulation surfaces for agent SDKs. It
does not run or proxy the old TypeScript `msg-router` service.

## Implemented Slice

- `channel_accounts` store provider identity metadata, provider credentials, webhook secrets,
  bot-level config, and bot visibility. One provider can have many accounts, so
  the same channel type can run multiple external bots.
- `channel_bot_agent_links` store the bot-to-Clawdi-agent relationship,
  including the one-time-issued agent SDK token hash. Raw agent tokens are
  returned only when a link is created or rotated.
- `channel_secrets` stores extra encrypted provider secrets such as WhatsApp app secrets.
- `channel_bindings` map external chats to a specific bot-agent link and
  enforce one active route per `(external bot, external chat)` session. The
  same external bot can link to multiple agents, and one agent can be reachable
  through multiple bots, but one chat session talks to only one agent at a time.
  Bindings also record the external actor that claimed the route.
- `channel_pair_codes` authorize a user to bind a chat by sending `/bot_pair`
  and are scoped to a bot-agent link.
- `/bot_unpair` archives a single active binding across Telegram, Discord,
  WhatsApp, and iMessage ingress. Pairing the same chat with a different
  bot-agent link moves the active route to that link only when the command is
  sent by the external actor that claimed the current binding.
- `channel_messages` records inbound and outbound channel traffic.
- `channel_messages.inbox_sequence` is the channel-native inbox cursor used by
  Telegram polling and Discord gateway replay.
- `channel_deliveries` is the durable outbound outbox processed by `pdm run channels-worker`.
- `pdm run discord-gateway-worker` maintains Discord Gateway connections for active Discord accounts and records dispatch events through the backend service.
- `/api/channels` creates and lists native channel accounts.
- `/api/channels/{id}/agent-links` lists or creates agent-scoped bot links;
  `/api/channels/{id}/agent-links/{link_id}/token` rotates a hashed agent token.
- `/api/channels/{id}/pair-codes` issues one-time pairing codes.
- `/api/channels/{id}/bindings` lists bound chats.
- `/api/channels/{id}/commands/sync` registers Clawdi pair/unpair commands through provider APIs.
- `/api/channels/{id}/messages` enqueues outbound delivery through the backend outbox.
- `/api/admin/channels` is the server-to-server management surface for
  preconfigured public bots: create/list/read/patch/archive provider accounts,
  rotate webhook secrets, update encrypted provider tokens/secrets, and run
  provider-wide command sync. It is hidden from public OpenAPI generation.
- `/api/channels/telegram/{id}/webhook` receives Telegram updates natively.
- `/api/channels/telegram/bot/{agent_token}/getMe|getUpdates|setWebhook|deleteWebhook|getWebhookInfo|sendMessage`
  exposes a Telegram Bot API-compatible agent face.
- `/api/channels/discord/{id}/webhook` receives Discord HTTP interactions and dispatch-shaped payloads.
- `/api/channels/discord/v10/gateway`, `/api/channels/discord/v10/gateway/bot`,
  `/api/channels/discord/v10/users/@me`,
  `/api/channels/discord/v10/applications/.../commands`, and
  `/api/channels/discord/v10/channels/.../messages`
  expose Discord REST-compatible agent slices.
- `/api/channels/discord/gateway` exposes a Discord Gateway-compatible websocket
  for Identify, Heartbeat, Ready, Resume, and MESSAGE_CREATE dispatch replay.
- `/api/channels/whatsapp/{id}/webhook` receives WhatsApp Cloud API or Baileys-shaped payloads.
- `/api/channels/whatsapp/graph/v{graph_version}/{phone_number_id}/messages` exposes a WhatsApp Cloud
  Graph API-compatible text-send surface for agent SDKs pointed at Clawdi.
- `/api/channels/whatsapp/{id}/tenant-creds` mints Python-native Baileys-shaped
  tenant credentials scoped to a bot-agent link, persists the Noise identity
  public key hash for future tenant resolution, and returns the stable Clawdi
  auth cert plus websocket and media proxy URLs.
- `app.services.whatsapp_noise` contains the Python-native WhatsApp Noise
  XX_25519_AESGCM_SHA256 handshake state machine, frame packing, minimal
  Handshake/CertChain protobuf encoding, and minimal WABinary node encoding.
- `/api/channels/whatsapp/media/...` proxies WhatsApp encrypted media CDN reads to `mmg.whatsapp.net`
  while preserving range requests and dropping agent-side auth/cookie headers.
- `whatsapp_media_reupload.py` decrypts/verifies private-chat encrypted WhatsApp image/audio media in memory,
  uploads it to Graph `/media`, and queues the resulting media id through the
  existing WhatsApp delivery outbox without persisting plaintext media.
- `whatsapp_native_transport.py` provides a tested native-runtime seam plus a
  Baileys sidecar HTTP client contract, preserving Baileys additional attrs for
  native-only relay paths without reintroducing the old TypeScript `msg-router`
  process.
- `whatsapp_sidecar_registry.py` wires configured sidecars into the shared-bot
  transport registry at FastAPI lifespan startup and closes/unregisters them on
  shutdown, while keeping unavailable configured sidecars observable in debug
  health.
- `packages/whatsapp-baileys-sidecar` provides the minimal Clawdi-owned
  Baileys protocol adapter for WhatsApp Web live runtime: bearer
  auth, health, outbound proto relay, raw node send, IQ query, multi-file auth
  state, and byte-safe WABinary JSON encoding.
- `/api/channels/imessage/{id}/webhook` receives BlueBubbles/Photon-shaped payloads.
- `/api/channels/imessage/bluebubbles/v1/server/info`,
  `/api/channels/imessage/bluebubbles/v1/message/text`, BlueBubbles webhook
  self-registration, scoped chat/message query routes, and
  `/api/channels/imessage/bluebubbles/socket.io/` expose the Python-native
  BlueBubbles-compatible REST/Socket.IO surface.

## Source Parity

The old `msg-router` repository contains more than HTTP routing. It owns
provider runtimes and SDK emulation for Telegram, Discord, WhatsApp, and
BlueBubbles/iMessage. This migration ports those behaviours into backend
routes, service modules, database outboxes, and Clawdi-owned workers instead of
copying the TypeScript runtime into the monorepo.

## Schema Migration

The channel schema is delivered by one Alembic revision:
`2d4c8e1b7a90_clawdi_native_channels.py`. It creates the final channel tables,
indexes, inbox sequence, delivery outbox, debug events, attachment/schedule
state, agent references, WhatsApp credentials, and sidecar auth-cert storage in
one step. Intermediate development migrations are intentionally squashed out of
the PR.

## Channel Domain Model

The native channel model is intentionally split by responsibility:

| Concept | Table | Meaning |
| --- | --- | --- |
| External bot | `channel_accounts` | Provider identity, visibility, and transport credentials, such as a Telegram bot, Discord application/bot token, WhatsApp phone, or BlueBubbles server. |
| Bot-agent link | `channel_bot_agent_links` | Authorization edge from one external bot to one Clawdi AgentEnvironment. This owns the hashed agent SDK token and link-local agent SDK state such as Telegram webhook and command shadows. |
| Conversation route | `channel_bindings` and `channel_binding_aliases` | External chat ids and provider aliases routed to exactly one active bot-agent link per account. |
| Inbox/outbox message | `channel_messages` and `channel_deliveries` | Routed traffic carrying `bot_agent_link_id` so agent-facing polling, Gateway replay, BlueBubbles queries, and outbound sends are link-scoped. |
| Ephemeral pairing | `channel_pair_codes` | One-time claim code scoped to the target bot-agent link. |

This supports multiple bots per provider, multiple agent links per bot, and
many-to-many routing between bots and agents without overloading the provider
account row. The route itself is not many-to-many: a given `(channel account,
external chat id)` has at most one active binding, so a conversation session
cannot be handled by multiple agents at the same time.

Channel accounts have `visibility = private | public`. User-created channel
accounts are always `private`: only the account owner can see them, link them,
delete them, or pair them, and they can only be linked to that user's agents.
Clawdi-preconfigured shared bots are stored as `public`: any authenticated user
can list the account and create their own bot-agent links and pair codes for
their own agents, but provider-token management, deletion, and provider-wide
command sync remain owner/admin operations. Public bot links, pair codes,
bindings, messages, deliveries, attachments, scheduled messages, and
WhatsApp tenant credentials are owned by the requesting/link user, not by the
bot account owner. Operationally, create and manage public bots through the
server-to-server `/api/admin/channels` endpoints; do not expose visibility or
provider credential management on the ordinary user create-channel API.

Agent-facing SDK credentials are link-scoped, not agent-scoped. If two external
bots are both linked to the same Clawdi agent, each `(bot, agent)` link still
gets its own mock bot token. That token resolves to one `channel_accounts` row
and one `channel_bot_agent_links` row, so Telegram Bot API, Discord REST/Gateway,
WhatsApp Graph/Baileys, and BlueBubbles-compatible calls cannot accidentally
read or mutate another bot just because both bots target the same agent.

The routing invariant is: provider identity lives on the external bot, agent
authorization lives on the bot-agent link, and chat delivery lives on the
conversation route. New channel adapters should resolve inbound traffic to a
`ChannelBinding`, store both `binding_id` and `bot_agent_link_id` on messages,
and require the link id for agent-facing inbox, ack, webhook replay, websocket
replay, and SDK-compatible sends. Account-level sends by `external_chat_id`
resolve through the single active route; agent-authenticated routes must still
match the route's current `bot_agent_link_id`.

Pairing control is actor-scoped, not just chat-scoped. Provider ingress must
extract both the external chat id and the external user/sender id. The first
successful `/bot_pair <code>` stores that sender on `channel_bindings`; later
`/bot_pair` and `/bot_unpair` commands for the same active chat must come from
the same external actor. This prevents another participant in a group from
unpairing someone else's route or replacing it with their own agent. Non-DM
pair/unpair commands without an extracted actor are rejected instead of creating
a legacy unowned group route. Pair and unpair commands are system commands and
are marked handled, including failures, so pair codes are not forwarded to the
current agent as ordinary messages.

Provider-wide state, such as real upstream bot credentials, remains on
`channel_accounts`. Agent-facing SDK state that can differ per agent token must
live on `channel_bot_agent_links`; otherwise one agent can accidentally block or
change another agent on the same shared bot. Telegram `setWebhook`,
`deleteWebhook`, `getWebhookInfo`, `getUpdates`, and command shadows follow
this rule, while provider-side command synchronization is restricted to chats
owned by the current link.

| Provider | Clawdi-native status | Notes |
| --- | --- | --- |
| Telegram | Python-native Bot API slice | Account creation, webhook secret validation, pair/unpair binding, command sync through `setMyCommands`, inbound persistence, `/api/channels/telegram/bot/{agent_token}/getUpdates`, webhook-mode storage, and outbound `sendMessage` through both the delivery worker and the agent-facing Bot API. |
| Discord | Python-native REST/Gateway slice | Account creation, webhook secret or Ed25519 interaction verification, pair/unpair binding, provider command sync, tenant-shadowed application commands, inbound persistence, outbound channel `messages` REST send, route/global rate-limit bucket tracking, Discord Gateway dispatch recording through `pdm run discord-gateway-worker`, and agent-facing Gateway replay at `/api/channels/discord/gateway`. |
| WhatsApp | Python-native Cloud/API plus Baileys boundary layer | Account creation, webhook verification, HMAC signature support via encrypted `app_secret`, pair/unpair binding, LID/PN alias routing, inbound persistence, outbound Cloud API text/media send through the delivery worker, Graph-shaped `/api/channels/whatsapp/graph/v{graph_version}/{phone_number_id}/messages` for Cloud API clients, Baileys-shaped tenant credential minting, stable auth cert persistence, Noise handshake/frame primitives, agent prekey bundle parsing, IQ responder policy, relay authorization policy, media proxy URL/HTTP handling, and encrypted image/audio media reupload through Graph media IDs. |
| iMessage / BlueBubbles | Python-native HTTP/API/Socket.IO slice | Account creation, BlueBubbles/Photon webhook ingest, pair/unpair binding, inbound persistence, outbound `/api/channels/imessage/bluebubbles/v1/message/text`, `/api/channels/imessage/bluebubbles/v1/server/info`, webhook self-registration, scoped query routes, inbound webhook fan-out, and Socket.IO event fan-out. |

## Migration Rule

Do not add a subprocess/proxy seam for the old `msg-router`. Port product
behaviour into backend modules and Clawdi-owned workers. A minimal
Clawdi-owned Baileys sidecar is allowed only as the WhatsApp Web protocol
adapter: it must not own routing, database state, product APIs, retry policy, or
tenant authorization.

`pdm run channels-worker` is the Clawdi backend worker process for delivery
outbox retries, agent webhook redelivery, and Discord Gateway capture. It is not
the old Node msg-router worker. `pdm run discord-gateway-worker` is an optional
single-purpose deployment/debug entrypoint for the Discord Gateway component
when operators want to scale or inspect it separately.

See `docs/designs/whatsapp-baileys-sidecar-runtime.md` for the W5 sidecar
contract and ownership split.

## Provider Port Closure

| Batch | Status | Port | Acceptance |
| --- | --- | --- | --- |
| W4 | Done | WhatsApp encrypted media reupload through Cloud API | Private-chat Baileys image/audio media with `mediaKey`/`directPath` is decrypted/verified in memory, uploaded to Graph media, and sent by media id through the delivery outbox; invalid media records a safe debug failure. |
| W5 | Done | Baileys sidecar live upstream shared-bot transport | Backend adapter/health semantics are implemented for outbound-message, raw-node, and IQ relay; `WhatsAppBaileysSidecarClient` defines the internal HTTP contract; `ConfiguredWhatsAppSidecarRegistry` registers configured sidecars per account during FastAPI lifespan; `packages/whatsapp-baileys-sidecar` implements the minimal Baileys runtime package; opt-in smoke proves the sidecar reaches `connected` against the FastAPI Baileys runtime. Real linked-account smoke is a deployment acceptance gate. |
| W6 | Done | Final product/ops closure | Route audit, stale marker search, matrix counters, full backend tests, opt-in Baileys smoke, and docs all agree. Backend APIs cover provider tokens, webhooks, pair codes, bindings, debug health, and metrics. |

The Python backend already owns creds, auth certs, Noise handshake/frame
primitives, generated WABinary token decode, IQ policy, relay policy,
Signal/group sender-key paths, alias routing, media proxying, real Baileys
open/inbox smoke coverage, structured Cloud API outbox delivery for sendable
text/reply/public-link image/audio WAProto, encrypted image/audio media
reupload, native transport adapter/health semantics, a Baileys sidecar client
contract, a minimal Clawdi-owned Baileys sidecar package, sidecar runtime smoke
against the FastAPI Baileys websocket, and Cloud-native private-chat read
receipt/typing relay. Production WhatsApp Web upstream readiness should be
accepted by running the sidecar with a real linked account under deployment
supervision.
