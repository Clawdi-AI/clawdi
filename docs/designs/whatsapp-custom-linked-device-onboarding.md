# WhatsApp Custom Linked-Device Onboarding

Status: physical account onboarding and Agent activation implemented
Date: 2026-08-02

This flow connects a user-owned WhatsApp account as a linked device. It extends
the existing physical Baileys sidecar; it does not add an application adapter,
a Meta Graph API facade, or a second Agent-side physical socket.

## Dynamic physical sessions

The backend generates an opaque provider session UUID inside the existing
idempotency/name allocation transaction. One business-neutral sidecar service
then creates `<state-root>/<session-id>/provider-state.sqlite` lazily. Each
session has exactly one physical socket and isolated auth/Signal state, while
all sessions share one internal endpoint and service bearer.

PostgreSQL owns tenant identity, Custom/Shared classification, lifecycle, and
capacity policy. The sidecar has no knowledge of those concepts. A pending
onboarding row durably owns its session UUID until confirmed cancel/logout and
a terminal transition. Session UUIDs are never reused for another physical
account.

## Lifecycle and Restart

The authenticated public lifecycle is:

1. `GET /v1/channels/whatsapp/onboarding/readiness` reports whether the provider
   service is configured and supports a manual pairing code.
2. `POST /v1/channels/whatsapp/onboarding/sessions` durably allocates a session and
   starts QR pairing. The user may request the secondary pairing-code path.
3. Status remains `generating`, `ready`, or `scanned` until the sidecar socket
   owner reports both registered auth and an open connection.
4. FastAPI creates the tenant-owned `ChannelAccount`, binds its durable id to
   the session's `WhatsAppProviderTransportAdapter`, starts provider ingress, and
   commits `connected`. A failed commit rolls back the account and unregisters
   the just-created transport/pump.
5. Cancel stops an unfinished socket. Deleting the connected Custom account
   logs out the linked device, confirms stopped+unregistered, stops ingress,
   unregisters the transport, and only then archives the account.

At backend startup and every reconciliation interval, each process rebuilds
`ChannelAccount -> provider session -> transport/pump` from active durable rows.
It validates session revision, sidecar session identity, the pinned Baileys rc14
source and Web version, and registration agreement. Missing auth, config drift,
duplicate ownership, or orphan physical state is blocked rather than exposed
as available capacity.

QR rotation and expiry are observed from the one physical sidecar socket owner.
Backend processes never infer expiry from their own polling clock, so a process
that did not start the socket cannot make a false expiry claim. A durable
`expired` transition is written only after the sidecar confirms the physical
pairing socket is stopped.

The sidecar owns these private bearer operations in addition to its provider
transport contract:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/capabilities` | Advertise the exact narrow pairing contract. |
| `GET` | `/v1/pairing/status` | Return socket-owner state and current ephemeral pairing material. |
| `POST` | `/v1/pairing/qr` | Start or idempotently observe QR pairing. |
| `POST` | `/v1/pairing/code` | Call pinned rc14 `requestPairingCode` after phone validation. |
| `POST` | `/v1/pairing/cancel` | Stop an unfinished unregistered session and clear its state. |
| `POST` | `/v1/pairing/logout` | Remove the companion device before clearing physical auth. |
| `POST` | `/v1/pairing/retry` | Reopen the same registered session for logout/recovery. |

QR text, pairing codes, and phone input exist only in no-store request/response
memory. They never enter PostgreSQL, URLs, logs, analytics, toast details, or
error bodies. Physical auth, Signal keys, retry data, and provider inbox data
remain in the sidecar's account-bound SQLite state and are never returned to
the browser.

## Agent Activation

Physical linked-device scan, account inventory, provider transport registration,
ingress, logout, and restart recovery remain separate from Agent Link and Pair.
A connected Custom account enters inventory first; the user then explicitly
Links it to an Agent and Pairs an authorized chat. Managed native traffic is
enabled without a runtime master feature flag after exact pinned OpenClaw and
Hermes stock-plugin E2E. Tenant/account/binding authority, provider connection
state, and compatibility validation continue to fail closed. A real live-account
message drill remains post-activation evidence and is not claimed here. This
onboarding does not depend on the rejected PR #713 application-adapter
architecture.

Done: the sidecar and focused backend onboarding, registry, transport, and
provider-bridge suites pass in isolated runners.
