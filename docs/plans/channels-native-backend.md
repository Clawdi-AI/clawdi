# Native Channels Backend Status

Status: implemented baseline; WhatsApp native runtime gated
Date: 2026-08-01

This document records the implemented native-channel boundary. Product
semantics live in
[`../designs/native-channels-product-model.md`](../designs/native-channels-product-model.md).

## Shared Backend

FastAPI and PostgreSQL own:

- channel accounts and encrypted provider credentials;
- bot-Agent Links and Link bearer authority;
- pair codes, actor-scoped bindings, and provider aliases;
- durable inbox messages and delivery outbox rows;
- provider-specific ingress validation and authorized outbound workers;
- debug events, retry state, and Link revocation.

A `(channel account, external chat)` has at most one active binding. Agent-facing
requests resolve one active Link and must match that binding. Provider-wide
credentials stay account-scoped; Agent credentials and replay state stay
Link-scoped.

Telegram, Discord, and iMessage keep their existing native backend adapters.
Generic delivery, retention, and ownership code must not acquire WhatsApp-only
payload assumptions.

## WhatsApp Boundary

WhatsApp uses two intentionally distinct socket roles:

1. `packages/whatsapp-baileys-sidecar` owns the one physical stock Baileys
   socket for a real account. It keeps durable linked-device auth, Signal keys,
   retry state, reconnect and QR/pair lifecycle, and an exclusive account-state
   owner lock.
2. The stock OpenClaw or Hermes native plugin owns a synthetic Link-scoped
   Baileys socket. Its synthetic credential never contains the physical auth
   directory, provider credential, or real account token.

The package name retains `sidecar` only to avoid manifest, dependency, and CI
churn. It is the physical-provider transport, not a second Agent runtime and not
an OpenClaw/Hermes application connector.

Provider ingress follows:

```text
physical Baileys messages.upsert
  -> disk-backed provider event handoff
  -> FastAPI account/JID alias and binding resolution
  -> committed channel_messages row
  -> sidecar event acknowledgement
  -> Link-scoped Noise inbox replay
  -> native plugin
```

Agent egress follows:

```text
native plugin
  -> synthetic Noise session
  -> Link + synthetic identity + binding authorization
  -> committed channel_messages/channel_deliveries row
  -> delivery worker
  -> account's registered physical provider transport
```

Allowed raw BinaryNode and bounded IQ operations bypass the application delivery
shape only after the same Link and binding checks. They are retained for
receipts, key/group queries, and protocol fidelity. There is no public raw-node,
IQ, provider-event, or transport HTTP API; those operations are on the private
bearer-authenticated contract between FastAPI and the physical transport.

## Preserved WhatsApp State

- `channel_agent_credentials`: Link-scoped synthetic auth, identity, Signal,
  group sender-key, and retry material.
- `channel_whatsapp_auth_certs`: synthetic Noise authority public/private state
  used by the emulator and internal runtime credential projection.
- `channel_bindings` and `channel_binding_aliases`: account-scoped PN/LID/JID
  ownership.
- `channel_messages` and `channel_deliveries`: durable provider/Agent boundary.
- configured provider transports: one registration per account plus the
  sidecar's exclusive durable-state lock.

The internal runtime-channel response may mint or reuse one synthetic credential
under the account row lock. Ordinary channel APIs do not expose credential mint/list,
credential revocation, or auth-certificate authority endpoints.

## Removed WhatsApp Compatibility Surface

The gated product no longer includes the former hosted compatibility layer for
Meta Cloud/Graph request shapes, webhook delivery assumptions, payload
conversion, provider media upload/reupload, media proxying, or the shared
application-runtime relay. The old public tenant credential and auth-certificate
routes, Web credential cache, CLI credential-mint flow, Hermes application
adapter projection, and custom OpenClaw/Hermes connector artifacts are also
absent.

Baileys proto bytes and BinaryNode bytes cross the provider boundary directly.
The backend inspects only the narrow ids and attributes needed for Link,
binding, alias, and relay policy.

## Gating

The managed WhatsApp path is not usable yet. The pinned `7.0.0-rc13` artifacts
`baileys` and `@whiskeysockets/baileys` lack the required configurable Noise
trust authority and a WebSocket-only managed marker header, so the CLI owns an
exact version-and-source-hash-gated static compatibility patch for those two
seams and their consumer socket-construction call sites. These are explicitly
downstream patch capabilities, not native upstream claims. Executable rc13 seam
tests do not replace OpenClaw/Hermes native-plugin E2E proof or a live drill.

The isolated artifact-seam evidence is true, but the aggregate constants in
`packages/cli/src/runtime/whatsapp-upstream-contract.ts` remain false. Runtime
projection does not materialize synthetic auth, reconcile the patch, or install
a WhatsApp egress profile. Fuzzy replacement, runtime monkey-patching, package
override, broad fork, and custom adapters remain outside the accepted design.

## Acceptance Evidence

- one `makeWASocket` production owner and no legacy connector source;
- physical-provider SQLite auth/Signal/retry/inbox state, exclusive ownership,
  HTTP contract, and typecheck;
- provider ingress persistence, alias resolution, durable outbound delivery,
  raw-node policy, bounded IQ forwarding, and Link revocation tests;
- managed/unmarked/invalid marker tests through the generic egress engine;
- executable patched rc13 WebSocket, HTTP, Noise trust, and consumer config
  reader evidence, without claiming native-plugin E2E;
- Link-removal stale-marker denial plus backend revoked/cross-Link authority
  denial;
- source invariants for no WhatsApp Graph/Cloud production path, no custom
  runtime adapter, and disabled readiness gates.

The file-by-file decision record is
[`../designs/whatsapp-native-baileys-cleanup-audit.md`](../designs/whatsapp-native-baileys-cleanup-audit.md).
