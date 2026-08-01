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
runtime. The OpenClaw projection disables the stock plugin before registering
the managed channel; OpenClaw rejects duplicate channel ids
([`registry.ts` lines 943-1037](https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/src/plugins/registry.ts#L943-L1037)).
Hermes explicitly enables the managed plugin whose same-name platform registry
entry takes precedence
([`platform_registry.py` lines 231-248](https://github.com/NousResearch/hermes-agent/blob/f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1/gateway/platform_registry.py#L231-L248)).
A missing managed artifact or link capability is a hard startup failure.

Hermes `handle_message()` schedules background work, so its return is not an
ACK boundary. The fixed `0.19.1` contract instead calls the public
`on_processing_complete` hook
([`base.py` lines 4892-4910](https://github.com/NousResearch/hermes-agent/blob/f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1/gateway/platforms/base.py#L4892-L4910))
on success
([`base.py` lines 6258-6273](https://github.com/NousResearch/hermes-agent/blob/f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1/gateway/platforms/base.py#L6258-L6273))
and failure/cancellation
([`base.py` lines 6319-6327](https://github.com/NousResearch/hermes-agent/blob/f3cda0ceb18d8ba7465a6d223098ef0e56c8fee1/gateway/platforms/base.py#L6319-L6327)).
The managed adapter journals before dispatch and ACKs only from that completion
hook. Offline recovery tests pass; the readiness gates remain false because the
runtime installers are mutable and the live drill is incomplete.

## Verification

Done: the following searches return no WhatsApp Graph profile, provider WSS
rewrite, or auth-state projection in runtime code:

```bash
rg -n "graph\.facebook\.com|WHATSAPP_GRAPH_API_BASE_URL|WA_WEBSOCKET_URL|HERMES_WA_CREDS_JSON|authDir|session_path|ws_url" packages/cli/src/runtime
```

Tests must also assert that the default OpenClaw Agent and default Hermes
profile load only the managed adapter, hold no provider credential, and never
instantiate a Baileys socket.
