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
| Windows | x64, arm64 | per-user NSIS; signed when credentials are configured | electron-updater over HTTPS + SHA-512; publisher verification when signed |

## Terminal command

Packaged builds include the matching native `clawdi` CLI. On each packaged
application launch, Desktop reconciles a lightweight launcher after startup checks:
macOS and Linux use
`~/.local/bin/clawdi`, while Windows uses a per-user launcher directory added to
the user PATH. An existing `clawdi` from another installation is never replaced.
The command continues to use the Desktop-managed binary, so native CLI updates
arrive with Desktop rather than through a second updater. AppImage builds refresh
an existing Desktop-owned launcher after an application update.

On macOS, move Clawdi to Applications first so the launcher points to a stable
application path. macOS and Linux do not edit shell startup files; when
`~/.local/bin` is absent from PATH, the launcher is still installed there and the
user may add that standard user directory to their preferred shell configuration.

The Desktop PR workflows use native macOS arm64/Intel, Ubuntu x64/arm64,
Windows x64 and `windows-11-arm` runners. They assert the runtime architecture,
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
`lib/browser/init.ts`; `linux.syncDesktopName` in electron-builder 26.16.0 derives
the desktop filename from it. Windows launchers use a UTF-8 BOM for PowerShell
5.1 script parsing, UTF-8 native process streams and explicit
`Out-File -Encoding unicode` (UTF-16LE) for logs; `daemon logs` and the log RPC
read that encoding. The native Windows lifecycle test checks a Unicode path and
the log BOM/content.

Clawdi Desktop opens the Dashboard in the system browser at `https://cloud.clawdi.ai`.
Set `CLAWDI_DESKTOP_WEB_URL` to a self-hosted HTTPS dashboard URL (or an HTTP
loopback URL for local development). Dashboard entry points never load remote
content into Electron. Only the bundled Connect wizard has a renderer and IPC.

The bundled CLI owns credentials, Agent registration, and daemon lifecycle.
Desktop sign-in runs the CLI's device authorization flow through
`clawdi auth login --desktop`. The CLI opens the prefilled verification page
(`verification_uri_complete`, falling back to `verification_uri`) in the system
browser. Desktop shows the short-lived code so the user can confirm it matches
the browser before approving. The CLI completes and saves its credentials on
approval; no local callback listener is used. Desktop never receives
tokens or creates a Clerk browser session; the Dashboard uses normal browser
sign-in independently. Signing out of Desktop uninstalls the daemon and signs the
CLI out. It leaves the browser's Dashboard session signed in.

Native shell and CLI changes require an application update. Dashboard deployments
take effect in the browser as normal. Packaged smoke tests verify the bundled
wizard and remote navigation rejection without contacting the hosted Dashboard.
Unit tests verify the system-browser handoff.

## Preview package

```bash
bun run --cwd apps/desktop package:preview
```

Preview packages are unsigned or ad-hoc signed and carry
`clawdiUpdateChannel=disabled`, so the updater skips them deterministically.
Release builds download updates in the background. A native notification announces
`Clawdi Desktop <version> is ready — restart to update`; clicking it or the
Restart to Install Update menu item uses electron-updater's default restart.
Quitting instead uses `autoInstallOnAppQuit` and does not relaunch Desktop.
macOS/Linux leave background services running through either installation path.
On the next Desktop launch, the existing reconciliation replaces a live daemon
whose version or executable path differs from the bundled CLI. Windows waits for
the existing service-stop operation to release executable locks before installing.
Its preserved Sync task resumes through account-verified reconciliation on the
next Desktop launch, or its next logon trigger. Install-on-quit leaves Windows
Sync stopped until then; choose Restart to Install Update to reopen Desktop.
DEB/RPM installations only check for a newer version and show a non-blocking
notification and a Download New Version menu link to the GitHub release page.
They never download or install an update through electron-updater.

## Release package

On the native target runner, run:

```bash
bun run --cwd apps/desktop package:release
```

Set `CLAWDI_DESKTOP_VERSION`, `CLAWDI_DESKTOP_ARCH`,
`CLAWDI_DESKTOP_UPDATE_CHANNEL` and `CLAWDI_DESKTOP_UPDATE_FEED_URL` explicitly.
For signed Windows releases, set `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` and
`CLAWDI_WINDOWS_PUBLISHER` together (the complete certificate Subject DN, for example
`CN=Clawdi Inc., O=Clawdi Inc., C=US`). Copy the exact Subject returned by
`Get-AuthenticodeSignature`; do not use only the CN display name. The first two are
standard electron-builder Windows signing variables, independent of Apple's
`CSC_LINK`. Set the publisher as a GitHub repository variable of the same name.
Partial Windows signing configuration fails before building. With all three values
unset, the build emits a `-unsigned.exe`, its `.exe.blockmap`, and standard
`latest.yml`/`beta.yml` referencing that exact filename. Unsigned Windows updates
use HTTPS and electron-updater's SHA-512 validation, the same integrity model as
the CLI. `win.verifyUpdateCodeSignature=false` omits `publisherName` from
`app-update.yml`; no custom verifier is installed. With all three set, the default
`verifyUpdateCodeSignature=true` and configured publisher enable verification.
The build verifies Authenticode and exact
Subject equality on the installer, app and CLI, and checks the publisher pin in
`app-update.yml`. Linux requires no Apple/Windows secrets; its AppImage feed
uses SHA-512 checksums over HTTPS. DEB/RPM repository signing belongs to the
package repository operator.

Unsigned Windows installers may show SmartScreen's unknown-publisher warning,
and Defender may scan, quarantine, or block the installer or bundled CLI. Check
the official release source and your organization's policy; Desktop does not
bypass these protections. Publisher authenticity is not verified until signing
is configured. TODO (2026-10-08): provision the three signing settings above and
validate a signed beta-to-beta update; that configuration turns publisher
verification on without a client verifier change. Existing unsigned clients
accept that signed successor over the same HTTPS/checksum feed, and the new
installed client then pins the publisher.

Done: the command exits 0 with installers and any applicable validated metadata
under `release/`. It never publishes. Signed Windows and macOS verification
requires real signing credentials.

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
bun run --cwd apps/desktop package:release
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
beta channel and version first. Every release job and publication job
requires `refs/heads/main`, including build-only signing runs. Feature/PR builds
use the unsigned Desktop Platform Packages workflow. The feed URL comes from the
official configure-pages action. By default it only builds; explicitly select
publish to create a Desktop release after required signing, notarization and smoke
checks pass. Windows is signed only when its three signing settings are complete.
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
Unsigned Windows releases use the same Windows feeds. The `.exe.blockmap`
asset stays beside the exact `-unsigned.exe` referenced in the metadata.
The GitHub Release includes one `SHA256SUMS` covering all assets;
the DMG remains the user installer and the ZIP remains Squirrel.Mac's update payload.
macOS also uploads `<renamed ZIP filename>.blockmap`; packaging refuses a missing
blockmap, matching electron-updater's `<ZIP URL>.blockmap` differential requests.
Both channels are rebuilt from all published Desktop releases, choosing their
highest eligible semantic version, so CLI releases and older-version reruns cannot
move the feed backwards. Metadata comes from electron-builder, not a custom protocol.
DMG hashes are refreshed after stapling. Never manually replace release assets.

If Pages deployment fails after publication, rerun Desktop Update Site instead
of publishing again. A failed preparation leaves the existing site untouched.
Workflows become dispatchable once present on the default branch.

The standard electron-updater client reads its sole feed configuration from
electron-builder's `app-update.yml`; no `setFeedURL` override or custom package
feed URL is used. Release packaging validates that YAML against the strict HTTPS
input and channel. The client selects `latest` or `beta`, checks after
30 seconds, every six hours and after system resume, and supports Check for Updates. Automatic
downgrades are disabled. Channel selection is build-time, not an in-app switch.
Beta remains on the beta feed even after a stable release; install the signed
stable DMG manually to leave beta. Stable publication never changes beta metadata.
Validate a signed beta-to-beta upgrade on a Mac before general distribution;
the old disabled preview cannot self-update.

### Rollout and pause control

Stable releases enter the feed 24 hours after GitHub `published_at`, with
electron-updater's documented `stagingPercentage: 25` through the first 48 hours,
then `stagingPercentage: 100`. Beta has no age gate or staging percentage. The
Desktop Update Site workflow regenerates both channels hourly, on Desktop release
publication, and on manual dispatch. It compares every prepared file (including
`index.html`) and removed feeds with live Pages using curl, skipping upload and
deployment when unchanged. A generated file returning 404 requires deployment;
a feed already absent both locally and online does not. Failed preparation or
comparison preserves the deployed feed. Generation checks existing Pages versions
and refuses an unexplained regression; a pause may point the feed at an older
eligible release for users who have not installed the paused version. Clients
never downgrade an installed app.

Owner: set the repository variable `DESKTOP_PAUSED_VERSIONS` to comma-separated
versions (no `desktop-v` prefix), then regenerate the feed:

```bash
gh variable set DESKTOP_PAUSED_VERSIONS --body '1.2.3,1.3.0-beta.2'
gh workflow run desktop-update-site.yml --ref main
```

Resume by removing the version from the variable (an empty value pauses nothing),
then dispatch the same workflow. If every release in a channel is paused, its
metadata files are omitted. A pause cannot revoke an already downloaded update
or roll back an installed version; ship a higher version to repair those clients.
Never delete or modify immutable release assets to halt an update.

Done: after the workflow succeeds, the relevant `latest*.yml` or `beta*.yml` on
the configured Pages URL names the newest eligible non-paused version, or returns
404 if the channel has no eligible release.

### Background services during updates

Installation on quit does not reopen Desktop. macOS/Linux do not stop the daemon:
the running process continues with its existing binary while the bundle or image
is replaced. On the next launch, [`daemon-runtime.ts`](src/daemon-runtime.ts) and
the existing account-verified startup reconciliation compare live daemon versions
and executable paths against the bundled CLI, then reinstall the service when
they differ. The macOS service uses the stable installed app bundle path.

AppImage is identified through its documented
[`APPIMAGE` environment variable](https://docs.appimage.org/packaging-guide/environment-variables.html).
The bundled CLI is copied from the mount to the existing durable
`userData/runtimes/<version>` runtime before service registration. systemd points
at that copy, which survives Desktop exit and AppImage replacement; no service
definition points at a transient `/tmp/.mount_*` path. Reconciliation installs
the new runtime on the next launch, then prunes older runtime copies.

Windows stops the task process tree before installation to release file locks,
retaining its registration as durable Sync intent. NSIS upgrades preserve the task.
The next Desktop launch verifies the account and Agent registrations and restarts
the stopped task through [`auth-orchestrator.ts`](src/auth-orchestrator.ts).
Notification/menu installation calls `quitAndInstall()` with its documented
default restart; install-on-quit uses upstream `install(true, false)` and does not
relaunch. Known Windows limitation: after install-on-quit, Sync remains stopped
until Desktop next launches or the Task Scheduler logon trigger runs. Failed
account/Agent verification needs attention before Desktop can resume Sync.
The Windows e2e checks this stop/preserve/restart path with a real Task Scheduler
process; its account and Agent responses are fixtures. Signed Windows updates
still require signing credentials and real-device verification by the owner.

### Linux update end-to-end check

```bash
bash apps/desktop/scripts/update-e2e.sh
```

Done: the isolated Docker check builds only two Linux x64 AppImages (0.0.1 and
0.0.2), trusts a task-local CA in NSS, verifies a real HTTPS download and its SHA-512
in the updater cache, quits through the production shutdown path, and launches the
replaced image to assert 0.0.2. It uses a fake bundled CLI and does not prove OS
service recovery. The container is limited to 4 GiB, builds run serially, and the
script cleans up its containers, image and processes. PR CI path-filters both update jobs
to Desktop, its release/update workflows and direct build dependencies.
Real macOS/Windows signed beta-to-beta checks remain required before first signed stable.

### Windows update end-to-end check

In an elevated session on a disposable Windows x64 runner without an existing
Clawdi Sync task (the test temporarily trusts its CA in the machine store):

```powershell
bun apps/desktop/scripts/update-e2e-windows.ts
```

Done: output includes `Windows update e2e passed`. The `windows-latest` PR job
builds unsigned N and N+1 NSIS installers using the release configuration,
silently installs N, and downloads N+1 from a local HTTPS feed trusted by a
test-only CA. It checks artifact names, SHA-512 and blockmaps, installation on
quit, N+1 launch, and startup recovery of a real Task Scheduler task. Account/Agent
responses are fixtures; this does not prove hosted account connectivity. It
removes its task, certificate, installation and processes on exit, publishes
nothing, and has per-process bounds plus a 25-minute job timeout.

## Verification and external gates

```bash
bun run --cwd apps/desktop test
```

Done: the isolated Docker runner passes Desktop typechecking and tests. It does
not validate Windows or macOS execution. The Windows lifecycle test is opt-in
(`CLAWDI_WINDOWS_TASK_TEST=1`) and refuses to replace an existing task. Only run
it in a disposable CI account. Release publication waits for all six native
builds. Missing Windows secrets select unsigned updates over HTTPS + SHA-512;
partially configured secrets fail closed. A local cross-compile does not establish
runtime support.

Before general distribution, validate browser OAuth, persistent session restore,
account switching, Agent reconnect and a signed beta-to-beta update with test
accounts on every OS/architecture. Hosted OAuth contracts are unchanged. Signing
credentials, live test accounts and native runner execution are external gates;
this repository does not create credentials or alter hosted infrastructure.

Official contracts: [Bun targets](https://bun.sh/docs/bundler/executables),
[electron-builder auto-update](https://www.electron.build/docs/features/auto-update/),
[Windows signing](https://www.electron.build/docs/features/code-signing/code-signing-win),
[NSIS customization](https://www.electron.build/docs/nsis), and
[Task Scheduler security contexts](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks).
The updater's `Provider` source defines metadata suffixes; NSIS `publisherName`
enables downloaded-installer signature verification.
The locked `app-builder-lib@26.17.0` signing manager reads `WIN_CSC_LINK`, and
`WinPackager.doGetCscPassword` prefers `WIN_CSC_KEY_PASSWORD`. Its
`createTransformerForExtraFiles` signs `.exe` files while copying extraResources,
including `resources/native/clawdi.exe`; the ordinary builder pipeline also
signs `Clawdi.exe` and the NSIS installer. No custom signing hook is used. The
release script checks all three signatures and the complete Subject. The default
electron-updater 6.8.9 verifier compares the configured DN fields; no custom
verifier or weaker CN-only fallback is installed.
