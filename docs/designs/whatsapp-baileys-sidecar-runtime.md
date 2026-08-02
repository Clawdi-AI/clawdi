# WhatsApp Physical Provider Transport and Native-Agent Noise Boundary

Status: gated; no production projection
Date: 2026-08-01

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
  -> authorized proto/node/IQ operation
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

The auth directory contains Baileys durable auth/Signal state, a durable retry
counter cache, and `.clawdi-provider-owner.lock`. A second process cannot open
the same account state while the owner is live. Reconnects retain the lock;
clean shutdown releases it.

FastAPI registers one provider transport per account through
`CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON`. Its loopback HTTP contract is private:

| Method | Path | Required native operation |
| --- | --- | --- |
| `GET` | `/v1/health` | Observe the configured physical socket. |
| `POST` | `/v1/relay-message` | Relay an authorized Baileys message proto with its message id and attributes. |
| `POST` | `/v1/raw-node` | Send an ownership-checked receipt or other allowed BinaryNode. |
| `POST` | `/v1/query-iq` | Forward the bounded IQ subset required by the synthetic Noise session. |

These are provider-transport operations behind an internal bearer, not a
public application relay API. Raw nodes and IQs remain because the native Noise
bridge calls them after backend policy checks; removing them would break
receipts, key/group queries, and protocol fidelity.

Done: `bun test packages/whatsapp-baileys-sidecar/src` exits 0 and
the owner-lock tests report that a second account socket cannot reuse the same
durable state.

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
