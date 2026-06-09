# OpenClaw/Hermes MITM And Patch Replacement Inventory

**Status:** current implementation plan
**Last updated:** 2026-06-09

Canonical hosted runtime design:
[`../hosted-runtime.md`](../hosted-runtime.md).

## Decision

The hosted runtime keeps OpenClaw and Hermes as upstream runtimes with zero
Clawdi source patches.

Use native runtime configuration wherever OpenClaw or Hermes exposes a stable
surface. Use Clawdi native Channels for channel-owned protocol behavior. Use the
broker/MITM layer only as an egress, trust, and credential projection layer when
native runtime configuration cannot express the required endpoint or credential
source.

The target activation command is:

```bash
clawdi run -- hermes
clawdi run -- openclaw
```

In hosted mode this command reads the persisted runtime run config, starts a
local broker when a managed profile bundle exists, injects standard proxy and
trust environment into the child process, and then execs the upstream runtime
command. Normal startup must not require endpoint, token, or certificate flags.

MITM is not a replacement for:

- runtime-native provider/model semantics;
- local runtime state;
- OpenClaw/Hermes updater source of truth;
- channel ownership policy;
- Clawdi hosted service channel activation.

## Channel Boundary

All hosted channel credentials and product semantics are owned by Clawdi hosted
service native Channels. The CLI consumes the runtime manifest and secret
values; it does not activate channels, pair accounts, or expose a private RPC
surface for channel control.

| Channel | Owner | Runtime-facing contract |
| --- | --- | --- |
| Telegram | Clawdi native Channels | Bot API-compatible HTTP surface. |
| Discord | Clawdi native Channels | Discord REST and Gateway-compatible surfaces. |
| WhatsApp | Clawdi native Channels | Runtime-facing bridge surface; hosted service owns real protocol state. |
| iMessage | Clawdi native Channels | BlueBubbles/Photon-compatible service path and trust config. |

Current hosted manifests use top-level `channels`; the schema is strict so
undeclared top-level fields are rejected.

## Agent Vault Reference Patterns

Agent Vault is the concrete implementation reference for the transport layer,
not for Clawdi product ownership.

Patterns to copy:

- `run -- <command>` is the activation boundary for the child process.
- The child receives `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, and
  `http_proxy` pointing at one plain HTTP local proxy listener.
- The proxy listener handles `CONNECT` for HTTPS upstreams and absolute-form
  forward-proxy requests for plain HTTP upstreams.
- Proxy-scoped auth headers are stripped before upstream forwarding.
- The run wrapper writes/projects a CA PEM and injects common trust env:
  `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
  `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, and `DENO_CERT`.
- `NODE_USE_ENV_PROXY=1` is injected for Node runtimes that honor env proxy
  natively.
- `OPENCLAW_PROXY_URL` is injected for OpenClaw proxy-aware paths.
- WebSocket upgrade/tunnel traffic is implemented and tested explicitly.
- Request logs redact tokens and sensitive payload values.
- Network egress policy must block metadata/private ranges unless explicitly
  allowed.

Patterns not to copy:

- Do not require a separate broker server product boundary for Clawdi hosted
  runtime.
- Do not expose a Clawdi RPC route for channel control in the CLI.
- Do not store proxy tokens in Docker args or user-mutated dotfiles.

## Framework Decision

The implementation path is a Clawdi-managed native broker child process,
modeled after Agent Vault's split between CLI orchestration and local proxy
transport:

1. Keep `clawdi` as the single user-facing command and update surface.
2. Generate persisted non-secret MITM profiles from `clawdi runtime init`.
3. Resolve managed secrets at run time into short-lived broker state.
4. Let hosted `clawdi run -- <runtime>` and `clawdi run -- <command>` start
   `clawdi-mitm-broker` as a managed child process, wait for readiness, project
   CA/proxy env, then exec the upstream runtime or tool.
5. Package the broker as a relocatable `clawdi-mitm-broker/` bundle next to the
   standalone `clawdi` package entrypoint.

Why native broker:

- one small broker artifact instead of bundling Python plus mitmproxy;
- no dependency on system Python, uv, or host-installed proxy tooling;
- the request profile model, secretRef gate, rewrites, and lifecycle are all
  Clawdi-owned and testable in one repo;
- profile and run config contracts do not depend on broker implementation
  internals, so the transport engine can be replaced later.

## Replacement Matrix

| Legacy patch class | Preferred replacement | Notes |
| --- | --- | --- |
| Telegram custom endpoint | Native runtime config if available; otherwise broker egress rewrite to a Clawdi native Bot API-compatible channel surface. | Token matching belongs in broker secret resolution, not logs or Docker args. |
| Discord REST base URL | Native config if available; otherwise broker egress rewrite to a Clawdi native Discord REST-compatible channel surface. | Requires host/path allowlist and network egress enforcement. |
| Discord Gateway/WebSocket endpoint | Native gateway config if available; otherwise broker WebSocket tunnel/rewrite to a Clawdi native Gateway-compatible channel surface. | Requires explicit WebSocket support and cannot rely only on cooperative env vars. |
| WhatsApp endpoint/state patch | Runtime-facing channel bridge. | Hosted service owns real WhatsApp protocol state; CLI/image do not own protocol state. |
| iMessage endpoint patch | BlueBubbles/Photon-compatible native channel service. | Hosted service owns iMessage service state and cert handling; CLI only projects endpoint/trust config. |
| Certificate trust patch | Project broker CA only when TLS interception is enabled. | Prefer explicit proxy roots; avoid broad system trust mutation when possible. |
| Hosted-managed Codex official behavior | Broker MITM to managed provider. | Cover both `api.openai.com/v1/responses` and `chatgpt.com/backend-api/codex/responses`; managed provider credentials are injected by secretRef, not forwarded from user tokens. |
| Ordinary OpenAI-compatible provider base URL changes | Native AI provider projection/direct provider URL. | Use this where official OpenAI behavior does not need to be simulated. Do not silently proxy user BYOK traffic. |
| Runtime update endpoint/channel patch | Do not replace with MITM. | Native OpenClaw/Hermes updater authority stays with the runtime. |

## MITM Scenario Matrix

| Scenario | Upstream-looking request from runtime | Match condition | Broker action | Target owner | Priority |
| --- | --- | --- | --- | --- | --- |
| Discord REST channel | `https://discord.com/api/v10/...` | `Authorization: Bot <configured-token>` matches channel secretRef | Rewrite to native channel REST surface; strip broker-only headers; redact token. | Clawdi native Channels | P0 |
| Discord Gateway channel | `wss://gateway.discord.gg/?v=10...` | Gateway host allowlist and enabled channel profile | WebSocket tunnel/rewrite to native channel Gateway surface. | Clawdi native Channels | P0 |
| Telegram Bot API channel | `https://api.telegram.org/bot<TOKEN>/<method>` | `<TOKEN>` matches channel secretRef | Rewrite to native Bot API-compatible channel surface; do not log token-bearing URL. | Clawdi native Channels | P0 |
| WhatsApp channel | Runtime-facing WhatsApp bridge URL or upstream-compatible shim | Manifest enables WhatsApp channel profile | Route only to the hosted channel bridge; do not own real WhatsApp protocol state. | Clawdi native Channels | P0 |
| iMessage channel | BlueBubbles/Photon-compatible HTTP(S) service path | Manifest enables iMessage channel profile | Project endpoint/trust config or broker route to hosted iMessage-compatible service. | Clawdi native Channels | P0 |
| Codex hosted-managed official OpenAI behavior | `https://api.openai.com/v1/responses` from Codex | Provider policy explicitly marks Clawdi-managed Codex brokerage | MITM and rewrite to managed Responses-compatible provider while preserving official-looking Codex request shape. Never use for user BYOK. | Clawdi provider layer | P1 |
| Codex ChatGPT backend behavior | `https://chatgpt.com/backend-api/codex/responses` | Official path plus managed provider policy | Rewrite to managed Responses-compatible provider and replace upstream authorization from provider secretRef. | Clawdi provider layer | P1 |
| Ordinary OpenAI-compatible provider projection | Runtime/provider-specific configured base URL | Provider can be expressed natively and does not need official `api.openai.com` simulation | Project native provider config/direct URL; no MITM. | User/runtime or Clawdi provider projection | P1 |
| Generic service credential brokerage | Any allowlisted HTTP(S) host/path | Broker policy has service rule and secret refs | Inject headers/query/path substitutions from secret refs; redact request logs. | Broker policy | P2 |
| CA trust projection | Any TLS-intercepted host | Broker policy enables TLS MITM | Project per-run CA file and trust env; avoid broad system trust mutation. | `clawdi run` | P0 |
| Egress deny/bypass prevention | Any non-allowlisted egress | Runtime network policy enabled | Deny or force proxy; block metadata/private ranges unless explicitly allowed. | Runtime platform + broker | P0 |
| Native OpenClaw/Hermes updater endpoints | Runtime updater traffic | Runtime update flow | Do not hide with MITM. Native updater repo/channel must stay explicit and auditable. | OpenClaw/Hermes | Rejected |
| User BYOK provider traffic | User-configured provider direct URL | User-owned credentials, no hosted-managed policy | Prefer native projection/direct provider URL. Do not silently proxy or record model traffic. | User/runtime | Rejected |

## Broker Requirements

A production broker/MITM path needs:

- persisted broker config loaded by hosted `clawdi run`;
- no normal startup endpoint/token flags;
- a container or network boundary that prevents bypass in hosted mode;
- HTTP CONNECT, absolute-form HTTP forwarding, and WebSocket support;
- per-service host/path/method allowlists;
- credential lookup by secret reference or short-lived runtime file;
- endpoint rewrite to Clawdi native channel surfaces where native runtime config
  is missing;
- standard proxy/trust env injection for the child process;
- request logging that redacts tokens and payload-sensitive fields;
- clear CA projection rules when TLS interception is enabled;
- tests with local fake upstreams for channel and provider routes.

## Verification Scope

This CLI repository verifies the reusable broker and runtime-convergence
contract. Deployment-specific hosted service tenants, provider gateway
credentials, runtime image boot timing, and real inbound channel canaries belong
to an external runtime platform smoke lane.

Current in-repo coverage:

- profile schema validation for HTTP, WebSocket, provider, and deny profiles;
- secretRef matching without persisting secret values in desired state;
- broker HTTP CONNECT, TLS interception, request rewrite, and WebSocket
  upgrade/tunnel behavior;
- proxy/CA env projection through `clawdi run`;
- official-looking route profiles for Telegram Bot API, Discord REST/Gateway,
  BlueBubbles/iMessage, WhatsApp bridge, and Codex/OpenAI Responses-compatible
  requests using local or fake upstreams;
- strict schema rejection for undeclared hosted manifest fields.

Route kinds expected from the runtime source:

| Route kind | Scope | Notes |
| --- | --- | --- |
| `telegram-bot-api` | Hermes/OpenClaw-compatible traffic | Official `api.telegram.org` traffic can be rewritten to a native Bot API-compatible channel surface. |
| `discord-rest` | Hermes/OpenClaw-compatible traffic | Official `discord.com/api/...` REST traffic can be rewritten to a native REST-compatible channel surface. |
| `discord-gateway-ws` | Hermes/OpenClaw-compatible traffic | Gateway traffic requires explicit WebSocket support, not only HTTP forwarding. |
| `bluebubbles-rest` | iMessage-compatible traffic | BlueBubbles-compatible iMessage REST can be routed to a compatible hosted service surface. |
| `whatsapp-ws-upgrade` | Runtime-facing WhatsApp bridge | The broker may route a bridge WebSocket, but real WhatsApp protocol state remains outside the CLI. |
| `codex-openai-responses` | Codex/OpenAI-compatible provider traffic | Official OpenAI Responses endpoint shape can be preserved while routing to a managed provider. |
| `codex-chatgpt-backend-responses` | Codex official backend shape | Requests to `chatgpt.com/backend-api/codex/responses` are matched by official path and forwarded with a managed provider bearer token. |

Priority meaning:

- P0: required for zero-patch hosted native channel runtime.
- P1: required for hosted-managed Codex official-behavior simulation and
  ordinary provider projection boundaries.
- P2: generalization after the channel and provider cases are pinned.
- Rejected: intentionally not implemented through MITM.
