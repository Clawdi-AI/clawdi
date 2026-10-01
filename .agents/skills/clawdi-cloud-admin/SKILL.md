---
name: clawdi-cloud-admin
description: Operate the Clawdi Cloud Admin API for Agent identity, credentials, settings, channels, managed AI providers, and workload bootstrap. Use for server-to-server Cloud administration; Hosted deployment and billing belong to the Hosted control plane.
---

# Clawdi Cloud Admin

Use direct Cloud Admin API requests. This skill belongs to the `clawdi`
repository; its contract is [admin routes](../../../backend/app/routes/admin.py)
and [request models](../../../backend/app/schemas/admin.py).

## Select The Owner

Cloud owns Agent identity, runtime-manifest projection, channels and providers.
Hosted owns deployment lifecycle and billing. For Hosted v2 resources, route
creation, key replacement, provider changes and runtime-state repair to the
owning declarative controller (A3). Admin access does not transfer ownership.

Use canonical `/v1/admin/*` paths. `/api/admin/*` and
`/v1/admin/environments*` are compatibility aliases. Cloud's `/v1` prefix
does not identify a legacy runtime; keep the current v2 ownership rules.

| Task | Read when needed |
| --- | --- |
| Agent identity/runtime authority, API keys, suspension and global settings | [Identity and access](references/identity-access.md) |
| Managed Provider metadata, credentials and fenced removal | [AI providers](references/ai-providers.md) |
| Channel inventory, credentials, commands and WhatsApp pairing | [Channels](references/channels.md) |
| Workload client/signing bootstrap and verifier grants | [Platform bootstrap](references/platform-bootstrap.md) |

The bundled [user-facing Clawdi skill](../../../packages/cli/skills/clawdi/SKILL.md)
serves user tools and context. It does not grant Cloud administrator access.

## Cloud API Access

Load `CLAWDI_CLOUD_API_URL` and `CLAWDI_CLOUD_ADMIN_API_KEY` from the
runner's approved source for the exact Cloud service. Its backend setting is
`ADMIN_API_KEY`; pass the value in `X-Admin-Key`. Hosted's admin credential
and `X-Admin-API-Key` header are separate.

After verifying the endpoint, inspect registered global settings:

```bash
curl -fsS --connect-timeout 5 --max-time 30 \
  -H "X-Admin-Key: $CLAWDI_CLOUD_ADMIN_API_KEY" \
  "$CLAWDI_CLOUD_API_URL/v1/admin/settings"
```

Missing/wrong admin authentication returns `401`; an unconfigured admin key
returns `503`. Stop on access failures without cycling credentials. Report
sanitized HTTP errors; never print secrets or enable shell tracing.

Admin routes are hidden from public OpenAPI and generated user clients.
Verify contracts against the owner source rather than inventing a binding.
See [API compatibility](../../../docs/api-compatibility.md#canonical-surface)
and [local admin setup](../../../docs/backend-development.md#local-admin-api).

## Target And Mutation Rules

- Establish the exact service, resource owner and target before a write.
  Use Cloud UUIDs for Agent/channel/key IDs, `target_clerk_id` for Clerk
  account operations, and `{kind, ref}` where a `PlatformOwner` is required.
  Hosted user sqids and `hdep_...` deployment IDs cannot replace them.
- Read-only work within the requested task needs no extra confirmation.
  Existing explicit authorization covering a write's target, values and
  effects is sufficient. Record its receipt and use supported read-back;
  report any verification gap where the API has no read surface.
- Validate path identifiers and encode query values with `--data-urlencode`.
  Use private approved JSON files for credentials and complex mutation bodies.
  Preserve masked summaries instead of raw tokens, key responses or config.
- After a timeout, inspect state before retrying. `X-Request-ID` correlates
  logs; only a verified endpoint contract provides replay safety. Key minting,
  channel creation and secret rotation must not be repeated blindly.
- Send the route's required `Idempotency-Key` and revision/identity proof.
  A conflict requires inspection; never change a key or proof to bypass it.
- Use supported APIs and the owning control plane. Missing endpoints are
  evidence gaps, not permission to substitute SQL, scripts, provider calls
  or tenant-file edits. Platform workload APIs use their own authentication.

Done: report the exact Cloud target, fresh evidence, authorized write receipts
and read-back or explicit gaps. Never claim Hosted convergence from a Cloud
database projection alone.
