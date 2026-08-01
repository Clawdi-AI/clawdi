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
only an environment-backed OpenClaw `apiKey` reference. Secret values remain in
the private runtime bundle and are not written into the provider patch.

Codex OAuth uses OpenClaw's native subscription route. Credential convergence
uses the public `openclaw/plugin-sdk/provider-auth` export and a namespaced
Clawdi-owned profile. It preserves other profiles and order entries, and it
fails closed when the required native store contract is unavailable.

## Verification

The maintained coverage is in:

- `packages/cli/src/runtime/manifest-reconciliation.test.ts` for strict Hosted
  admission and provider replacement;
- `packages/cli/tests/runtime.test.ts` for full runtime convergence; and
- `packages/cli/src/lib/ai-provider-projection.test.ts` for model-field mapping.
