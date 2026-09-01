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
Stable builds download updates in the background and install them only after an
explicit restart or when the user quits Clawdi.

## Signed release package

Set an explicit stable `CLAWDI_DESKTOP_VERSION`, the expected
`CLAWDI_DESKTOP_TEAM_ID`, a standard electron-builder Developer ID signing
identity, and one of electron-builder's supported Apple notarization credential
tuples. Then run:

```bash
bun run --cwd apps/desktop package:mac:release
```

The command never publishes. It requires signing and notarization, verifies the
app and bundled CLI signatures, exercises the bundled CLI identity check, builds
DMG and ZIP artifacts, and verifies the ZIP checksum in `latest-mac.yml`. A release owner must attach
the signed DMG, signed ZIP, and metadata to the repository's latest calendar
GitHub Release before the stable update channel can be enabled operationally.
Every later release marked latest must keep valid Desktop metadata and its
matching ZIP available.
