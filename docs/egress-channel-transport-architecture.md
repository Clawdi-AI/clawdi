# Egress Channel Transport Architecture

Status: current for Telegram and Discord; WhatsApp rollout disabled
Date: 2026-08-01

> HISTORICAL - The research that previously occupied this file described a
> WhatsApp Graph rewrite and Baileys WebSocket interception. Both designs are
> retired. See
> [`designs/whatsapp-baileys-sidecar-runtime.md`](designs/whatsapp-baileys-sidecar-runtime.md)
> for the single-socket WhatsApp boundary.

## Boundary

Managed channel egress profiles are runtime-owned policy for provider traffic
that a supported upstream connector emits. A profile is derived from an active
`ChannelBotAgentLink`; the runtime sidecar enforces the profile and does not
become a second channel control plane.

Telegram and Discord keep their provider-native connector contracts. Their
managed profiles authenticate with a link capability and preserve the backend
trust chain:

```text
ChannelAccount -> ChannelBotAgentLink -> ChannelBinding
```

The profile builder must fail closed when a link, provider target, or required
secret reference is missing. It must not infer tenant access from an account id
alone.

## Transport Matrix

| Transport | Managed path | Policy |
| --- | --- | --- |
| Telegram Bot API HTTPS | Provider-native request through a link-scoped HTTP rewrite profile | Backend relay; binding and ownership checks remain server-side. |
| Discord REST HTTPS | Provider-native request through a link-scoped HTTP rewrite profile | Backend relay; REST capabilities are allowlisted. |
| Discord Gateway WSS | Provider-native socket through the managed passthrough profile | Gateway capability and replay state remain link-scoped. |
| WhatsApp | No generic egress profile | A managed application adapter calls the Clawdi relay. The only provider socket belongs to the Baileys sidecar. |

WhatsApp deliberately does not use an HTTP rewrite for a Cloud API, a provider
WebSocket MITM, a projected auth directory, or a stock OpenClaw/Hermes
connector. Agent runtimes receive a Clawdi link capability only; they do not
receive WhatsApp auth or Signal state, a pairing secret, a provider token, or a
provider socket URL.

## WhatsApp Adapter Rule

The managed OpenClaw channel plugin and Hermes platform plugin operate at the
public application-adapter layer. They consume normalized, link-filtered
events and submit typed operations to FastAPI. FastAPI revalidates the link and
binding before forwarding an allowed operation to the account's one registered
sidecar.

The adapters must never load the upstream stock WhatsApp connector. Doing so
would create a second socket owner and move provider credentials into the agent
runtime. A duplicate channel/platform registration, missing managed artifact,
or missing link capability is a hard startup failure.

Hermes does not currently expose a processing-complete acknowledgement seam:
its handler schedules background work before returning. The managed Hermes
adapter may be tested offline, but restart-safe receive acknowledgement remains
a rollout blocker. The WhatsApp readiness gates stay false until that seam and
the live drill are complete.

## Verification

Done: the following searches return no WhatsApp Graph profile, provider WSS
rewrite, or auth-state projection in runtime code:

```bash
rg -n "graph\.facebook\.com|WHATSAPP_GRAPH_API_BASE_URL|WA_WEBSOCKET_URL|HERMES_WA_CREDS_JSON|authDir|session_path|ws_url" packages/cli/src/runtime
```

Tests must also assert that the default OpenClaw Agent and default Hermes
profile load only the managed adapter, hold no provider credential, and never
instantiate a Baileys socket.
