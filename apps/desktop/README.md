# Clawdi Desktop

Clawdi Desktop packages the production TanStack dashboard as a local SPA. The
renderer keeps the `https://cloud.clawdi.ai` origin for Clerk and API behavior,
but executable UI is served only from the signed application bundle. CLI owns
OAuth credentials, Agent registration, and daemon lifecycle.

## Preview package

```bash
bun run --cwd apps/desktop package:mac
```

Preview packages are unsigned or ad-hoc signed and carry
`clawdiUpdateChannel=disabled`, so the updater skips them deterministically.
Stable builds download updates in the background and install them only through
the explicit Restart and Install command.

## Signed release package

Set an explicit stable `CLAWDI_DESKTOP_VERSION` and
`CLAWDI_DESKTOP_UPDATE_FEED_URL`. The feed must be
an owner-controlled strict HTTPS directory URL ending in `/`; it is embedded in
the signed application metadata and has no runtime default. Also configure a
standard electron-builder Developer ID signing identity and API key notarization:
`APPLE_API_KEY` (P8 file path), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`.
No separate Team ID configuration is required. Then run:

```bash
bun run --cwd apps/desktop package:mac:release
```

The command never publishes. It requires signing and notarization, verifies the
app and bundled CLI signatures, validates stapled notarization and Gatekeeper
assessment, exercises the bundled CLI identity check, builds DMG and ZIP
artifacts, and verifies the ZIP checksum in `latest-mac.yml`.

This repository does not currently contain the credentialed release job or the
owner-controlled generic feed infrastructure. Stable publication remains
blocked until both exist and atomically publish `latest-mac.yml` with its exact
signed ZIP. Do not substitute a GitHub `releases/latest` URL or publish from this
local packaging command.
