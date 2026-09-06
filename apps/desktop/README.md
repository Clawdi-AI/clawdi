# Clawdi Desktop

Clawdi Desktop packages the production TanStack dashboard as a local SPA. The
renderer keeps the `https://cloud.clawdi.ai` origin for Clerk and API behavior,
but executable UI is served only from the signed application bundle. CLI owns
OAuth credentials, Agent registration, and daemon lifecycle.

Dashboard uses a persistent Chromium partition for Clerk's browser session.
Startup first restores that session; only an expired or missing session requests
a CLI-backed sign-in ticket. An HttpOnly account marker and renderer identity
check prevent reuse under a different CLI account. Explicit sign-out/account
replacement clears the partition; ordinary restarts and session retries do not.
CLI credentials are never copied into renderer storage. The first launch after
upgrading an old in-memory build will still need one new browser session.

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
No separate Team ID configuration is required.

CI follows [GitHub's documented certificate import flow](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
using macOS `security` directly. The shared shell wrapper generates a random
temporary keychain password with OpenSSL, removes the P12 immediately after
import, and restores the keychain search list and deletes the temporary keychain
on success or failure. It does not grant all applications access to the key.
electron-builder uses `CSC_KEYCHAIN` and the installed, lockfile-pinned tool;
no third-party certificate-import Action receives the signing secret.

For local packaging, run:

```bash
bun run --cwd apps/desktop package:mac:release
```

The command never publishes. It requires signing and notarization, verifies the
app and bundled CLI signatures, validates stapled notarization and Gatekeeper
assessment, exercises the bundled CLI identity check, builds DMG and ZIP
artifacts, and verifies the ZIP checksum in `latest-mac.yml` (stable) or
`beta-mac.yml` (beta). Channel and version mismatches fail before building.

## GitHub release workflow

Enable GitHub Pages with GitHub Actions as its source before the first build.
This repository's Pages site is reserved for Desktop update metadata; do not
deploy an unrelated website over it. No new repository or server is required.

Run Desktop Release with channel and version. The feed URL comes from the
official configure-pages action. By default it only builds; explicitly select
publish to create a Desktop release after signing, notarization and smoke pass.
Beta uses `desktop-v1.2.3-beta.1` and GitHub prerelease; stable uses
`desktop-v1.2.3`. Neither changes the monorepo's Latest release. Existing tags
are never overwritten: failed draft uploads require inspection before retry.

The release job then calls Desktop Update Site, using the official Pages
upload/deploy actions. The site contains only `/desktop/latest-mac.yml` and
`/desktop/beta-mac.yml`; downloads point to immutable GitHub release assets.
Both channels are rebuilt from all published Desktop releases, choosing their
highest semantic version, so CLI releases and older-version reruns cannot move
the feed backwards. Metadata comes from electron-builder, not a custom protocol.
DMG hashes are refreshed after stapling. Never manually replace release assets.

If Pages deployment fails after publication, rerun Desktop Update Site instead
of publishing again. A failed preparation leaves the existing site untouched.
Workflows become dispatchable once present on the default branch.

The standard electron-updater client selects `latest` or `beta`, checks after
30 seconds and every six hours, and supports Check for Updates. Automatic
downgrades are disabled. Channel selection is build-time, not an in-app switch.
Validate a signed beta-to-beta upgrade on a Mac before general distribution;
the old disabled preview cannot self-update.
