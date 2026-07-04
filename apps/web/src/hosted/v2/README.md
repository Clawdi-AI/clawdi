# `apps/web/src/hosted/v2/`

Hosted-only Cloud product surfaces. The public OSS dashboard should not have a
top-level v1/v2 product distinction; those rollout names stay internal to the
hosted build and deploy API capabilities.

Route entrypoints still use the hosted build flag as a bundle gate plus
`<HostedProductGate>` as the per-user access gate.

## Boundaries

1. **Route entrypoints use `IS_HOSTED ? lazy(...) : null`.**
   This keeps hosted-only chunks out of OSS bundles. The route body must also
   render through `<HostedProductGate>` so a hosted build can enable Cloud
   capabilities per user.

2. **Components set `data-hosted="true"` and `data-v2="true"` on rendered roots.**
   The boundary test checks these markers so Cloud-only DOM can be distinguished
   from the base dashboard during dark-launch debugging.

## What lives here today

- `channels/` — Telegram, Discord, and WhatsApp channel management.
- `ai-providers/` — Model provider catalog, BYOK credentials, and Codex OAuth.
