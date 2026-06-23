# `apps/web/src/v2/`

V2 product surfaces that are not part of the hosted agent service. These pages
are hidden from OSS builds until the flows are ready to expose there, so route
entrypoints still use the hosted build flag as a bundle gate plus `<V2Gate>` as
the per-user access gate.

## Boundaries

1. **No dependency on `@/hosted/*`.**
   Hosted agent and billing modules may consume v2 capabilities, but v2 product
   modules must not reach back into hosted agent infrastructure.

2. **Route entrypoints use `IS_HOSTED ? dynamic(...) : null`.**
   This keeps the v2 chunk out of OSS bundles while the feature remains hidden.
   The route body must also render through `<V2Gate>` so a hosted build can
   enable v2 per user.

3. **Components set `data-v2="true"` on rendered roots.**
   The boundary test checks this marker so v2 DOM can be distinguished from
   hosted agent DOM during dark-launch debugging.

## What lives here today

- `channels/` — Telegram, Discord, WhatsApp, and iMessage channel management.
- `ai-providers/` — Model provider catalog, BYOK credentials, and Codex OAuth.
