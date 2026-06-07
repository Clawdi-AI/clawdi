# WhatsApp Baileys Sidecar Runtime

Status: adopted; runtime implemented
Date: 2026-06-07

## Context

The WhatsApp shared-bot product surface is not equivalent to WhatsApp Cloud API.
The old `msg-router` used Baileys for WhatsApp Web protocol behavior: linked
device sessions, Signal-encrypted messages, group sender keys, raw stanzas,
IQs, media download/decrypt, and relay attributes such as edits. The Clawdi
backend has already ported the product control plane, provider-prefixed APIs,
Cloud API delivery, Noise/Baileys-facing emulator slices, and Cloud-safe
runtime fallbacks into Python/FastAPI.

The live upstream boundary is the real WhatsApp Web protocol runtime. Hermes is
also Python, but its WhatsApp implementation does not call Baileys from Python.
Hermes starts a Node.js bridge, the bridge imports Baileys, and Python talks to
it through loopback HTTP. That is the useful precedent: keep the product
backend in Python and keep the WhatsApp Web protocol runtime in the ecosystem
where it is maintained.

## Decision

Clawdi should stop treating W5 as a pure-Python WhatsApp Web rewrite. W5 is now
the Baileys sidecar runtime.

The sidecar is allowed only as a Clawdi-owned protocol adapter. It is not the
old TypeScript `msg-router`, not a public API, and not a place for product
routing. FastAPI remains the only product backend.

## Ownership

| Area | Owner |
| --- | --- |
| Channel accounts, bindings, pair codes, agent routing, delivery outbox, webhook delivery, debug events, metrics, API prefixes, and dashboard/CLI management APIs | Clawdi FastAPI backend |
| WhatsApp Cloud API send/media/status/typing surfaces | Clawdi FastAPI backend |
| Baileys credential minting for agent-facing websocket emulation, Noise/WABinary fixture conformance, and opt-in real-Baileys smoke tests | Clawdi FastAPI backend |
| Linked-device socket lifecycle, `makeWASocket`, QR/pairing session operations, `sock.sendMessage`, raw node relay, IQ query, media download/decrypt when Cloud API cannot express the operation | Baileys sidecar |
| Product access control, tenant isolation, retry policy, debug redaction, and database writes | Clawdi FastAPI backend |

## Internal Contract

The Python seam is `WhatsAppSharedBotTransport`. `whatsapp_native_transport.py`
now provides:

- `WhatsAppNativeTransportAdapter` — adapts the shared-bot seam to any native
  runtime client.
- `WhatsAppBaileysSidecarClient` — HTTP client for a Baileys sidecar.

The implemented sidecar package lives at
`packages/whatsapp-baileys-sidecar`. It imports Baileys through the workspace
dependency alias `baileys -> @whiskeysockets/baileys`, starts one
`makeWASocket` session from a `useMultiFileAuthState` directory, and exposes a
small loopback HTTP surface:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/health` | Return `status`, `connected`, uptime, optional user identity, and last disconnect reason. |
| `POST` | `/v1/relay-message` | Relay one Baileys outbound proto with `jid`, `messageId`, `messageProtoBase64`, and `additionalAttributes` via `sock.relayMessage`. |
| `POST` | `/v1/raw-node` | Send one raw WABinary node using the JSON byte sentinel. |
| `POST` | `/v1/query-iq` | Send an IQ node and return `{ "node": ... }` or `null` within `timeoutMs`. |

Binary node content is encoded as:

```json
{ "$type": "base64-bytes", "base64": "AQID" }
```

The sidecar must require an internal bearer token or an equivalent private
service identity. It should bind only to loopback or a private service network.
No user-facing channel token should ever authenticate directly to the sidecar.

Runtime configuration is explicit:

- `CLAWDI_WA_SIDECAR_TOKEN` and `CLAWDI_WA_SIDECAR_SESSION_DIR` are required.
- `CLAWDI_WA_SIDECAR_HOST` defaults to `127.0.0.1`.
- `CLAWDI_WA_SIDECAR_PORT` defaults to `8787`.
- `CLAWDI_WA_WEBSOCKET_URL` may point Baileys at the Clawdi FastAPI WhatsApp
  websocket for local/runtime smoke.
- `CLAWDI_WA_AUTH_CERT_*` can inject the backend-minted auth cert shape.

The FastAPI backend registers sidecars through
`CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON`, a JSON object keyed by WhatsApp
channel account id:

```json
{
  "00000000-0000-0000-0000-000000000000": {
    "base_url": "http://127.0.0.1:8787",
    "api_token": "internal-sidecar-token",
    "timeout_seconds": 10
  }
}
```

Startup health checks are best-effort. A configured but unavailable sidecar is
still registered so `/api/channels/debug/health` can report `mode=sidecar` and
`shared-bot-transport-disconnected` instead of hiding the configured runtime.

## Non-Goals

- Do not run or proxy the old `msg-router` process.
- Do not put tenant routing, pair-code consumption, delivery retries, provider
  token storage, or debug-event persistence into JavaScript.
- Do not emulate Telegram, Discord, iMessage, or WhatsApp Cloud API inside the
  sidecar.
- Do not claim production upstream readiness until a real Baileys sidecar
  passes linked-account smoke under deployment supervision.

## Implementation Plan

1. W5a: backend seam and sidecar client contract.
   Done in Python with unit tests for relay payloads, raw node byte encoding,
   IQ response decoding, bearer auth, health, and debug-health `sidecar` mode.

2. W5b: minimal JS runtime package.
   Done in `packages/whatsapp-baileys-sidecar`. The package owns only socket
   lifecycle/session/protocol methods, requires bearer auth, exposes the four
   internal endpoints, preserves relay attrs, encodes raw node bytes with the
   shared JSON sentinel, and has unit tests for auth, validation, byte
   encoding, disconnected mapping, relay, raw-node, IQ, and env parsing.

3. W5c: runtime registration and process supervision.
   Backend registration is implemented:
   `ConfiguredWhatsAppSidecarRegistry` reads configured account mappings,
   creates `WhatsAppBaileysSidecarClient`, registers it behind
   `WhatsAppNativeTransportAdapter`, closes clients on lifespan shutdown, and
   leaves unhealthy configured sidecars visible in debug health. Process
   supervision remains an ops/deployment concern; FastAPI should not fork the
   Node sidecar itself.

4. W5d: sidecar smoke.
   Done for the protocol/runtime seam: the opt-in smoke starts the JS sidecar,
   seeds a Baileys `useMultiFileAuthState` session from backend-minted creds,
   points the sidecar at the FastAPI WhatsApp websocket runtime, and verifies
   sidecar health reaches `connected` with the expected JID. A real linked
   WhatsApp account smoke is still an environment/deployment acceptance gate,
   not a default CI requirement.

5. W6: closure.
   Done for code parity: route audit, stale marker search, full backend tests,
   opt-in smoke, and parity counters agree. Production upstream readiness still
   requires linked-account smoke in the deployment environment.
