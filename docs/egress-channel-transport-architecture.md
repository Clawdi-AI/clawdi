# Generic Egress and Native Channel Transport

Status: implemented, including WhatsApp stock-native projection
Date: 2026-08-01

Clawdi uses one generic, default-allow, profile-driven egress engine for model
providers and native channels. Runtime traffic for ports 80 and 443 is directed
to a runtime-fetched `mitmdump`; `packages/cli/egress-addon/clawdi_egress_addon.py`
interprets `clawdi.egressProfiles.v1`. The addon is not a channel connector and
contains no provider names, provider hostnames, placeholder formats, or product
routes.

## Generic Engine

The schema and interpreter support declarative:

- scheme, host, path, query, header, and expiry matchers;
- public equals/prefix and `secretRef`-backed equals/prefix matchers;
- rewrite, deny, passthrough, and priority;
- header removal and literal or `secretRef`-backed header injection;
- path replacement and URL/header redaction.

Profiles are matched by ascending priority and stable id. A request that matches
no profile remains on its original upstream request path. A matching `deny`
profile fails closed. Secrets are resolved only inside the egress process and
must not be embedded in the profile bundle.

Only hosts from non-passthrough profiles enter the TLS interception set. Once a
host is intercepted, an unmatched request on that host still uses the original
request-level upstream. This is not byte-for-byte TCP passthrough because the
local egress process has already terminated TLS.

## Provider Builders

Provider knowledge belongs in TypeScript profile builders. Each provider uses
the placeholder location native to its official client:

| Provider | Managed selector | Result after an exact match |
| --- | --- | --- |
| Telegram | Bot API placeholder in the request path | Rewrite to the Telegram backend boundary and inject the Link bearer. |
| Discord | Placeholder in REST Authorization or gateway identity | Rewrite to the Discord backend boundary and inject the Link bearer. |
| WhatsApp | Exact managed WebSocket-upgrade capability header | Rewrite to the Link-scoped Noise endpoint, strip the marker, and inject the Link bearer. |

The WhatsApp marker only selects a local profile. It is not the real provider
credential, not the Link bearer, and not a WhatsApp token. A missing marker is a
user-owned stock Baileys connection and retains official upstream behavior. A
present marker that is wrong, stale, or placed on another request is caught by
the lower-priority deny profile and fails closed.

The per-Link marker is deterministic and intentionally has no expiry: it is a
local profile selector, not backend authority. Link removal removes its valid
rewrite profile while retaining the catch-all marked-request deny profile.
Until that projection converges, the backend still rejects the revoked Link
bearer; it also binds synthetic Noise identity to that Link, so copying a
selector or synthetic identity across Links does not confer authority.

`packages/cli/tests/egress_addon/clawdi_egress_addon_test.py` runs all three
profile shapes through the same matcher and rewrite functions and asserts that
the addon source has no Telegram, Discord, or WhatsApp constants.

## Backend Boundary

The generic egress engine does not decide tenant or provider ownership. After a
rewrite, FastAPI resolves the injected Link bearer. Each provider boundary then
validates its own resource identity:

- Telegram validates the Bot API routing placeholder and chat binding.
- Discord validates application, guild/channel, and gateway identity.
- WhatsApp validates the active Link, synthetic Noise identity, and JID binding.

Invalid or revoked Link authority is rejected even for an already established
session. Local selector lifecycle is not the revocation mechanism.

Stock-plugin wildcard allowlists are transport acceptance only. Pair remains
the backend authority: active Link and binding checks decide every inbound
delivery and outbound target. Agent projection contains placeholders and
Link-scoped synthetic WhatsApp auth, never the physical provider credential.

## WhatsApp Topology

The WhatsApp egress profile routes only synthetic Agent sockets. It does not
replace the one physical provider transport needed for the real account. The
physical socket owns real linked-device auth and upstream ingress/egress; the
synthetic socket owns only Link-scoped Clawdi auth and talks to the Noise
emulator. See
[`designs/whatsapp-baileys-sidecar-runtime.md`](designs/whatsapp-baileys-sidecar-runtime.md).

The audited Baileys release lacks managed credential metadata and a safe
WebSocket-only header seam. The CLI owns a static compatibility patch for the
two installed Baileys aliases, conditioned on the expected package name, rigorously parsed
SemVer major 7, and unique exact before/after context for every audited hunk
with fuzz zero. Whole-file rc13 hashes are audit fixtures rather than
compatibility gates, so unrelated changes outside those hunks are preserved.
OpenClaw and Hermes source is not patched: their stock auth persistence carries
the namespaced `creds.additionalData` value through initial construction and
reconnect. Valid managed metadata forces Baileys' official WebSocket URL, adds
the marker only to a derived upgrade config, and supplies the Noise trust;
absent metadata preserves consumer URL/options and official trust. This is a
downstream CLI capability, not a native upstream managed capability.
Fixed-artifact stock OpenClaw and Hermes native-plugin E2E covers auth
reconstruction, reconnect, inbound, outbound, and representative protocol
envelopes. The real live-account message drill has not been executed and does
not control projection. Runtime convergence installs
Link-scoped WhatsApp credentials, the audited compatibility patch, and the
managed interception profile after ordinary authority and compatibility checks.

## Source Of Truth

- Profile schema: `packages/cli/src/runtime/egress-profiles.ts`
- Generic interpreter: `packages/cli/egress-addon/clawdi_egress_addon.py`
- Transparent redirect: `packages/cli/src/runtime/transparent-egress.ts`
- Telegram/Discord builders: `packages/cli/src/runtime/channels.ts`
- WhatsApp builder: `packages/cli/src/runtime/whatsapp-egress.ts`
- Static compatibility reconciler:
  `packages/cli/src/runtime/managed-baileys-compat.ts`
- WhatsApp marker and metadata contract:
  `packages/cli/src/runtime/whatsapp-upstream-contract.ts`
