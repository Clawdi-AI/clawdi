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

Set `CLAWDI_DESKTOP_UPDATE_CHANNEL` to `stable` (default) or `beta`,
an explicit `CLAWDI_DESKTOP_VERSION` (`1.2.3` or `1.2.3-beta.1` respectively), and
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
artifacts, and verifies the ZIP checksum in `latest-mac.yml` (stable) or
`beta-mac.yml` (beta). Channel and version mismatches fail before building.

The manual Desktop Channel Build workflow accepts channel, version, and feed URL
and produces signed, notarized artifacts without publishing. It becomes
dispatchable once the workflow exists on the default branch.

The owner-controlled HTTPS feed still needs deployment. Upload versioned ZIP/DMG
files first, then atomically replace only the chosen channel's YAML. Both YAML
files can coexist in one directory. Never overwrite `latest-mac.yml` with a beta
release. The standard electron-updater client selects `latest` or `beta`, checks
after 30 seconds and every six hours, and supports Check for Updates. Automatic
downgrades are disabled. Channel selection is build-time, not an in-app switch.

For GitHub prereleases, publish beta artifacts under a Desktop-specific tag with
`gh release create <tag> --prerelease --latest=false`. GitHub prerelease assets
alone do not populate the generic update feed. Do not use the monorepo's
`releases/latest` endpoint as that feed. Validate a signed beta-to-beta upgrade
on a Mac before enabling distribution; the old disabled preview cannot self-update.
