# Clawdi Desktop

The tray uses a monochrome Retina template icon and a single Sync checkbox.
The checkbox reflects the installed service (the user's persistent sync choice);
health is shown above the checkbox and in the tooltip, refreshed every minute.
Turning Sync off removes the service but retains
Agent bindings and credentials. Turning it on restores the service for verified
bindings or opens Connect an Agent when setup is needed.

Download the DMG for first installation. The ZIP is the same application packaged
for electron-updater/Squirrel.Mac and must remain a release asset; users do not
need both. Renderer dependencies are bundled at build time and must not also be
declared as production dependencies of the Electron shell.

## Platform coverage

| Platform | Architectures | Packages | Updates |
| --- | --- | --- | --- |
| macOS | arm64, x64 | signed/notarized DMG and ZIP | electron-updater, isolated architecture feeds |
| Linux with systemd user services | x64, arm64 | AppImage, DEB and RPM | AppImage auto-update; package manager for DEB/RPM |
| Windows | x64, arm64 | per-user signed NSIS | electron-updater with pinned Authenticode publisher |

Desktop Platform Packages uses native macOS arm64/Intel, Ubuntu x64/arm64,
Windows x64 and `windows-11-arm` runners. It asserts the runtime architecture,
executes the bundled CLI, and opens the packaged app. Windows additionally tests
Task Scheduler lifecycle and NSIS install/uninstall; Linux tests DEB installation
and AppImage first launch. Unsigned PR artifacts have updates disabled and are
previews, not signed release validation. An unavailable ARM runner is not a
successful runtime check.

Linux packages retain `/opt/Clawdi` ownership. AppImage copies the bundled CLI
and resources to `<Electron userData>/runtimes/<Desktop version>/` before use,
publishes the complete copy by rename, and re-registers a stopped installed
systemd unit after online registration verification. A live matching runtime
is left running. No service points into `/tmp/.mount_*`. Old version directories
remain until the replacement daemon installation succeeds; Desktop then prunes
only complete marker-owned older runtimes. A failed update therefore keeps the
still-referenced executable. Linux
requires a working systemd user manager, desktop keyring and AppImage/FUSE support.
Sync starts at user login; running without a logged-in session requires the
operator's systemd linger policy. Desktop does not change that policy.

Windows Sync is a Task Scheduler task named `Clawdi Sync <user SID>`, using
InteractiveToken and LeastPrivilege. It requires neither a stored password nor
LocalSystem. A private ACL protects its captured environment. Stop preserves
the task (Sync intent); restart starts it again; uninstall stops and deletes it.
NSIS removes the task on uninstall, preserving it during an upgrade. Windows CLI
targets compile with the pinned Bun 1.4.0 and ship through Desktop. The standalone
Unix v1 release manifest remains six entries so released CLI updaters and
`install.sh` remain compatible.

Before removing a macOS bundle, AppImage, DEB or RPM, turn Sync off in the tray
(or run the bundled `clawdi daemon uninstall`). Those OS package removers cannot
reliably run each logged-in user's service manager. Deleting an AppImage alone
does not delete its durable runtime or credentials. After disabling Sync, its
`runtimes` directory can be removed. NSIS performs service removal automatically.
After a manual DEB/RPM upgrade, restart Sync with the installed CLI's
`daemon restart` command if Desktop is not open. Desktop compares live daemon
versions and executable paths with its bundled CLI and refreshes an outdated
registration once per bundled CLI version in each process on every platform,
after online registration verification. Bootstrap reads do not mutate services.
Live legacy heartbeats without
a version/path also receive one refresh. Normal restart only restarts the existing
unit. AppImage separately rebinds stopped installed units once during recovery,
stopped units whose old ExecStart cannot be inferred from health records.

`desktopName` is official Electron package metadata, read by Electron 44.0.0's
`lib/browser/init.ts`; `linux.syncDesktopName` in electron-builder 26.15.3 derives
the desktop filename from it. Windows launchers use a UTF-8 BOM for PowerShell
5.1 script parsing, UTF-8 native process streams and explicit
`Out-File -Encoding unicode` (UTF-16LE) for logs; `daemon logs` and the log RPC
read that encoding. The native Windows lifecycle test checks a Unicode path and
the log BOM/content.

Clawdi Desktop loads the production Dashboard from `https://cloud.clawdi.ai`.
Web deployments take effect on the next Dashboard load or View > Reload Dashboard
without installing a new application. An active page is never forcibly reloaded.
Server-side rollback uses the existing Web deployment workflow. This is remote
HTTPS content in a sandbox, not downloaded JavaScript executed by the main process.
The native wizard and failure screen remain bundled and work when the site is
unavailable. Native shell, IPC additions, and CLI changes still require a signed
application update; beta.1 must upgrade once to acquire remote Dashboard support.

Only the trusted main frame receives the versioned, narrow Desktop bridge.
Web changes must preserve bridge v1 methods and feature-detect new capabilities
before calling them. Never require a new bridge method without an app update path.
CLI owns credentials, Agent registration, and daemon lifecycle. The production
site's CSP and TLS rules apply; no certificate bypass is installed. Production
documents use per-response CSP nonces through TanStack SSR and Clerk's nonce prop,
with no script unsafe-inline/unsafe-eval and no shared document caching.
The Web bridge adapter accepts the released unversioned beta.1 and version 1;
unknown versions or missing v1 methods display a Desktop upgrade message.

`clawdiDashboardSource=bundled` is retained for packaged SPA regression tests.
Those tests explicitly run `bun run --cwd apps/desktop build:bundled`. Ordinary
`build`, previews and releases omit `dist/web` and `web-assets.json` entirely;
the dedicated regression workflow supplies both the build flag and bundled
package metadata. No runtime code downloader or remote-to-bundled fallback is added.

Measured in isolated Linux x64 builds with Bun 1.4.0 / Electron 44.0.0, Desktop
`1.0.0-beta.1`: the bundled regression `dist` was 7,144,141 bytes versus 713,151
bytes for remote mode. AppImage size was 165,767,770 versus 163,175,989 bytes
(2,591,781 bytes smaller). Both build modes and the remote release artifact
checks passed; the remote build contains neither the SPA nor its asset manifest.
Production defaults to remote; failures show the local recovery UI rather than
silently mixing cached bundled code with current remote assets.

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

## Release package

On the native target runner, run:

```bash
bun run --cwd apps/desktop package:release
```

Set `CLAWDI_DESKTOP_VERSION`, `CLAWDI_DESKTOP_ARCH`,
`CLAWDI_DESKTOP_UPDATE_CHANNEL` and `CLAWDI_DESKTOP_UPDATE_FEED_URL` explicitly.
Windows additionally requires `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` and
`CLAWDI_WINDOWS_PUBLISHER` (the complete certificate Subject DN, for example
`CN=Clawdi Inc., O=Clawdi Inc., C=US`). Copy the exact Subject returned by
`Get-AuthenticodeSignature`; do not use only the CN display name. The first two are
standard electron-builder Windows signing variables, independent of Apple's
`CSC_LINK`. Set the publisher as a GitHub repository variable of the same name.
Missing credentials fail before building, even with `publish=false`. The build
verifies Authenticode and exact Subject equality on the installer, app and CLI, and checks the publisher pin
in `app-update.yml`. Linux requires no Apple/Windows secrets; its AppImage feed
uses SHA-512 checksums over HTTPS. DEB/RPM repository signing belongs to the
package repository operator.

Done: the command exits 0 with installers and validated metadata under `release/`.
It never publishes. Windows/macOS verification requires real signing credentials.

### macOS signing

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

Merge the change to `main`, then dispatch Desktop Release from `main` with a
beta channel and version first. Every signed release job and publication job
requires `refs/heads/main`, including build-only signing runs. Feature/PR builds
use the unsigned Desktop Platform Packages workflow. The feed URL comes from the
official configure-pages action. By default it only builds; explicitly select
publish to create a Desktop release after signing, notarization and smoke pass.
Beta uses `desktop-v1.2.3-beta.1` and GitHub prerelease; stable uses
`desktop-v1.2.3`. Neither changes the monorepo's Latest release. Existing tags
are never overwritten: failed draft uploads require inspection before retry.

The release job then calls Desktop Update Site, using the official Pages
upload/deploy actions. The original macOS arm64 feed stays at `/desktop/`; Intel
uses `/desktop/darwin-x64/`. Windows/Linux use `/desktop/<platform>-<arch>/`
(`win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`). Each directory contains
electron-updater's standard filenames: `latest.yml`/`beta.yml` on Windows,
`latest-linux.yml`/`beta-linux.yml` on Linux x64, and the `-arm64` variants on
Linux arm64. Release metadata asset names are architecture-qualified to avoid
upload collisions; Pages restores the standard names. Downloads point to
immutable GitHub release assets.
Both channels are rebuilt from all published Desktop releases, choosing their
highest semantic version, so CLI releases and older-version reruns cannot move
the feed backwards. Metadata comes from electron-builder, not a custom protocol.
DMG hashes are refreshed after stapling. Never manually replace release assets.

If Pages deployment fails after publication, rerun Desktop Update Site instead
of publishing again. A failed preparation leaves the existing site untouched.
Workflows become dispatchable once present on the default branch.

The standard electron-updater client reads its sole feed configuration from
electron-builder's `app-update.yml`; no `setFeedURL` override or custom package
feed URL is used. Release packaging validates that YAML against the strict HTTPS
input and channel. The client selects `latest` or `beta`, checks after
30 seconds and every six hours, and supports Check for Updates. Automatic
downgrades are disabled. Channel selection is build-time, not an in-app switch.
Beta remains on the beta feed even after a stable release; install the signed
stable DMG manually to leave beta. Stable publication never changes beta metadata.
Validate a signed beta-to-beta upgrade on a Mac before general distribution;
the old disabled preview cannot self-update.

## Verification and external gates

```bash
bun run --cwd apps/desktop test
```

Done: the isolated Docker runner passes Desktop typechecking and tests. It does
not validate Windows or macOS execution. The Windows lifecycle test is opt-in
(`CLAWDI_WINDOWS_TASK_TEST=1`) and refuses to replace an existing task. Only run
it in a disposable CI account. Release publication waits for all six native
builds; missing Windows secrets block the entire release. A local cross-compile
does not establish runtime support.

Before general distribution, validate browser OAuth, persistent session restore,
account switching, Agent reconnect and a signed beta-to-beta update with test
accounts on every OS/architecture. Hosted OAuth contracts are unchanged. Signing
credentials, live test accounts and native runner execution are external gates;
this repository does not create credentials or alter hosted infrastructure.

Official contracts: [Bun targets](https://bun.sh/docs/bundler/executables),
[electron-builder auto-update](https://www.electron.build/auto-update.html),
[Windows signing](https://www.electron.build/code-signing-win.html),
[NSIS customization](https://www.electron.build/nsis.html), and
[Task Scheduler security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks).
The updater's `Provider` source defines metadata suffixes; NSIS `publisherName`
enables downloaded-installer signature verification.
The locked `app-builder-lib@26.15.3` signing manager reads `WIN_CSC_LINK`, and
`WinPackager.doGetCscPassword` prefers `WIN_CSC_KEY_PASSWORD`. Its
`createTransformerForExtraFiles` signs `.exe` files while copying extraResources,
including `resources/native/clawdi.exe`; the ordinary builder pipeline also
signs `Clawdi.exe` and the NSIS installer. No custom signing hook is used. The
release script checks all three signatures and the complete Subject. The default
electron-updater 6.8.9 verifier compares the configured DN fields; no custom
verifier or weaker CN-only fallback is installed.
