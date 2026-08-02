# WhatsApp Custom Linked-Device Onboarding

Status: physical account onboarding implemented; Agent activation gated
Date: 2026-08-02

This flow connects a user-owned WhatsApp account as a linked device. It extends
the existing physical Baileys sidecar; it does not add an application adapter,
a Meta Graph API facade, or a second Agent-side physical socket.

## Static Beta Capacity

`CHANNEL_WHATSAPP_CUSTOM_BAILEYS_SIDECARS_JSON` is a static capacity map, not
dynamic provisioning. Every key is one durable capacity-slot UUID, every
origin is unique across the managed and Custom maps, and one sidecar owns
exactly one physical socket. The managed and Custom maps must not share a slot
UUID or origin.

A pending onboarding row reserves the slot in PostgreSQL before a slow sidecar
call begins. Its partial unique index prevents another tenant or request from
reserving the same slot while the state is `generating`, `ready`, `scanned`,
`connected`, or `error`. Capacity becomes available again only after a
confirmed cancel/logout and a terminal `canceled` or `expired` transition.

The non-secret digest of the slot UUID and canonical sidecar origin is stored
with both the reservation and the resulting `ChannelAccount`. Reusing a UUID
for a different origin is a configuration revision mismatch and fails closed.
Operators must use a new slot UUID for a replacement physical slot.

## Lifecycle and Restart

The authenticated public lifecycle is:

1. `GET /v1/channels/whatsapp/onboarding/readiness` reports verified static
   capacity and whether the pinned sidecar supports a manual pairing code.
2. `POST /v1/channels/whatsapp/onboarding/sessions` durably reserves a slot and
   starts QR pairing. The user may request the secondary pairing-code path.
3. Status remains `generating`, `ready`, or `scanned` until the sidecar socket
   owner reports both registered auth and an open connection.
4. FastAPI creates the tenant-owned `ChannelAccount`, binds its durable id to
   the slot's `WhatsAppProviderTransportAdapter`, starts provider ingress, and
   commits `connected`. A failed commit rolls back the account and unregisters
   the just-created transport/pump.
5. Cancel stops an unfinished socket. Deleting the connected Custom account
   logs out the linked device, confirms stopped+unregistered, stops ingress,
   unregisters the transport, and only then archives the account.

At backend startup and every reconciliation interval, each process rebuilds
`ChannelAccount -> slot -> provider transport/pump` from active durable rows.
It validates slot revision, sidecar account identity, the pinned Baileys rc13
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
| `POST` | `/v1/pairing/code` | Call pinned rc13 `requestPairingCode` after phone validation. |
| `POST` | `/v1/pairing/cancel` | Stop an unfinished unregistered session and clear its state. |
| `POST` | `/v1/pairing/logout` | Remove the companion device before clearing physical auth. |
| `POST` | `/v1/pairing/retry` | Reopen the same registered session for logout/recovery. |

QR text, pairing codes, and phone input exist only in no-store request/response
memory. They never enter PostgreSQL, URLs, logs, analytics, toast details, or
error bodies. Physical auth, Signal keys, retry data, and provider inbox data
remain in the sidecar's account-bound SQLite state and are never returned to
the browser.

## Product Gate

Physical linked-device scan, account inventory, provider transport registration,
ingress, logout, and restart recovery do not depend on managed Agent activation.
`WHATSAPP_LINKING_READY` remains false, so a connected Custom account is shown
as connected but not ready on an Agent. Agent Link, chat Pair, and native Agent
traffic must remain gated until managed compatibility PR #738 and native
end-to-end verification are ready. This onboarding does not depend on the
rejected PR #713 application-adapter architecture.

Done: `scripts/test.sh sidecar` reports 41 passing tests, and
`scripts/test.sh backend tests/test_whatsapp_custom_onboarding.py
tests/test_whatsapp_sidecar_registry.py tests/test_whatsapp_native_transport.py
tests/test_whatsapp_provider_bridge.py` reports 55 passing tests in isolated
runners.
