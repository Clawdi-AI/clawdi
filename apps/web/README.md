# Clawdi Web

TanStack Start dashboard for Clawdi.

## Development

For backend + dashboard + CLI together, use the canonical local-stack runbook in
[`../../AGENTS.md`](../../AGENTS.md#local-end-to-end).

```bash
bun install
bun run --cwd apps/web dev
```

Open http://localhost:3000.

## Mobile app links

Set these public signing identities in the Web server's deployment environment
(not `VITE_*` variables):

- `CLAWDI_APPLE_TEAM_ID`: the 10-character Apple Developer Team ID used as the
  application identifier prefix for `ai.clawdi.app`.
- `CLAWDI_ANDROID_CERT_SHA256`: comma-separated, colon-delimited SHA-256
  certificate fingerprints, including the **Play App Signing** certificate and
  the upload certificate for `ai.clawdi.app`.

`/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`
serve public JSON without authentication or redirects. Each returns 404 when
its signing identity is missing or malformed. AASA paths come directly from
[`@clawdi/shared/linking`](../../packages/shared/src/linking.cjs); `webcredentials`
uses the same Apple application identifier. Password autofill additionally
requires the app's `webcredentials` associated-domain entitlement. See
[Apple's association format](https://developer.apple.com/documentation/xcode/supporting-associated-domains)
and [Android's certificate guidance](https://developer.android.com/training/app-links/configure-assetlinks).

With the local Web server running and the relevant variable set, verify:

```bash
curl -i http://localhost:3000/.well-known/apple-app-site-association
curl -i http://localhost:3000/.well-known/assetlinks.json
```

Done: configured endpoints return 200 with `Content-Type: application/json`
and no `Location` header. Native builds must also configure the same link host
through `EXPO_PUBLIC_CLAWDI_LINK_HOSTS` (see
[`../../docs/mobile-development.md`](../../docs/mobile-development.md)).

## Verification

Use the canonical web verification set in
[`../../docs/frontend-development.md`](../../docs/frontend-development.md#verification).
