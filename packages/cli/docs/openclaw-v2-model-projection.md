# OpenClaw Hosted Model Projection

This document describes the current Core Hosted manifest path. Local AI
Provider activation commands are not part of this contract.

## Authority And Flow

The Hosted controller supplies one configured provider, or no provider in
unmanaged mode. The public wire keeps `provider_ids` as an array, while manifest
admission limits a configured OpenClaw runtime to exactly one entry.

During convergence, `packages/cli/src/runtime/manifest.ts`:

1. validates the selected runtime and its provider projection;
2. resolves the selected provider and model from the manifest;
3. calls `buildAgentTargetProjection("openclaw", ...)` from
   `packages/cli/src/lib/ai-provider-projection.ts`;
4. produces the OpenClaw-native provider patch; and
5. sends that patch through OpenClaw's config-patch interface as part of the
   managed convergence transaction.

There is no provider fallback or secondary-provider ordering. A later Hosted
selection replaces the previous projection, and unmanaged mode removes only
the projection previously owned by Hosted convergence.

## Model Metadata

The portable catalog maps to OpenClaw model entries as follows:

| Catalog field | OpenClaw field |
| --- | --- |
| `id` | `id` |
| `label` | `name`, falling back to `id` |
| non-default `api_mode` | `api` |
| `input_modalities` | `input` |
| `context_window` | `contextWindow` |
| `max_tokens` | `maxTokens` |

Managed model discovery is normalized by
`packages/cli/src/runtime/managed-model-resolution.ts`. Canonical
`context_window` and `max_tokens` win over the discovery aliases
`context_length` and `max_output_tokens`. Unknown discovery fields are ignored,
and an ID-only discovery result does not erase matching manifest metadata.

## Authentication Boundary

API-key providers use the manifest's canonical secret reference and project
only an environment-backed OpenClaw `apiKey` reference with explicit
`auth: "api-key"`. Secret values remain in the private runtime bundle and are
not written into the provider patch.

The normalized `clawdi` provider is reserved for this managed projection. Its
`CLAWDI_AI_API_KEY` environment SecretRef is the sole API-key authority. Older
generated catalogs accidentally serialized that marker literally, and an
OpenClaw doctor fix could persist it as a local `clawdi:default` profile before
the plugin declared its env metadata. Prevention belongs in the plugin
manifest:

```json
{
  "setup": {
    "providers": [{ "id": "clawdi", "envVars": ["CLAWDI_AI_API_KEY"] }]
  }
}
```

Explicit provider auth controls execution precedence but does not replace that
doctor marker declaration. During a proven managed `clawdi` env projection,
convergence uses the public config-mutation SDK to remove normalized `clawdi`
entries from `auth.profiles` and `auth.order`, including order references to
the removed IDs. It then uses the public provider-auth SDK to remove all
normalized `clawdi` profiles and related order, `lastGood`, and usage state
from the default/main store, active agent store, discovered state-tree agents,
and configured custom agent directories. Empty auth containers are normalized.
Non-`clawdi` config and profiles are preserved, and unmanaged mode does not run
the cleanup.

Codex OAuth uses OpenClaw's native subscription route. Credential convergence
uses the public `openclaw/plugin-sdk/provider-auth` export and a namespaced
Clawdi-owned profile. It preserves native refreshes and logout semantics, and
it fails closed when the required public SDK contracts are unavailable.

## Verification

The maintained coverage is in:

- `packages/cli/src/runtime/manifest-reconciliation.test.ts` for strict Hosted
  admission and provider replacement;
- `packages/cli/tests/runtime.test.ts` for full runtime convergence; and
- `packages/cli/src/lib/ai-provider-projection.test.ts` for model-field mapping.
