# Android fixture smoke

From the repository root, install the frozen Bun dependencies and pass a local
**development** APK containing `expo-dev-client`:

```sh
bun install --frozen-lockfile
JAVA_HOME=/path/to/jdk scripts/mobile-e2e.sh --apk /path/to/development.apk
```

Java 17+, KVM access, an Android SDK with emulator/platform-tools/build-tools, and an
existing AVD are required. Set `ANDROID_SDK_ROOT` and `ANDROID_AVD_HOME` for
other locations; `--avd` defaults to `clawdi-preview`. No SDK/AVD is created,
and no native build is run by the script. An EAS `preview`/`production` binary
cannot use fixture authentication; the old `com.clawdi.preview` APK without
`expo-dev-client` is also rejected before starting processes.

The script reserves emulator port **5564**, fixture API **8796**, and Metro
**8096**; occupied ports cause failure without touching their owners. It boots
the existing AVD read-only with WiFiPacketStream disabled, installs the APK,
starts a fresh fixture server and one Metro worker, and opens Expo SDK 57's
[development-client URL](https://docs.expo.dev/develop/development-builds/development-workflows/).
It waits for boot completion, stopped boot animation and the resumed HOME
launcher before installing or launching the app, re-resolving HOME until
Android's temporary FallbackHome has been replaced. Only this emulator's Metro
port is mapped with `adb reverse` so the client
can use the server's localhost manifest and bundle URLs. Expo's upstream
headless mode disables the desktop DevTools installer. SDK 57 has no public
equivalents for this or isolated Expo user state; the script cites the upstream
implementations of `EXPO_UNSTABLE_HEADLESS` and
`__UNSAFE_EXPO_HOME_DIRECTORY`.
The manifest and JavaScript come from Metro with development-only auth bypass
and both API URLs pointing at `10.0.2.2:8796`. No Clerk key or real account is
used. Maestro 2.11.0 is downloaded from its official release, checked against
the publisher's SHA-256, and extracted only into a disposable task directory.
For retries or offline runs, `--maestro-archive /path/to/maestro.zip` reuses a
previously downloaded official ZIP with the same pinned checksum validation.

`smoke.yaml` runs launch, Home → Agent detail, Agents → another Agent detail,
Sessions → fixture transcript, Library → project bundle, and Account → settings
menu → General and API Keys. The flows use loaded fixture entity IDs, including a transcript message.
Native tab Triggers retain test IDs. On Android, react-native-screens 4.26.2
exports those IDs only as Espresso View tags, so Maestro uses short tab labels
scoped to native Material tab items by their container, with no index selectors. The flows
cite the upstream limitation. Settings menu rows use `settings-row-<panel>` test IDs;
`@expo/ui`'s Compose `testID` modifier exports them as resource IDs.
The first card is on the initial viewport: the launch flow waits for its loaded
fixture ID without scrolling during data loading. Visibility waits share the
same startup budget because Maestro 2.11.0 deducts time since the last
interaction from subsequent waits. The navigation flow waits for visual idle,
then permits at most three tap attempts only while the original card remains
visible, followed by the loaded detail header assertion. Maestro's documented
`retryTapIfNoChange` (two attempts) also failed in a separate cold-start run. In a
cold-start diagnostic, the first tap attempt produced no React Native touch
or press event despite a settled screen, correct app focus, and unfrozen input
dispatch. The underlying native cause remains unconfirmed; idle alone did not
resolve it. No diagnostic hooks remain in product code. Maestro is limited to ten
minutes, service readiness/install/downloads have separate bounds, and exit
traps stop only processes started by this run, including on failure or
interruption. The emulator receives its own shutdown signal so SDK helpers
can exit normally; netsimd is never signaled. Runtime files are removed. Logs,
JUnit results and screenshots remain under a unique ignored
`test-results/mobile-e2e.*` directory; `--output`
can select a new directory. `ANDROID_USER_HOME` is task-local before the first
adb call. An existing shared adb server is explicitly reused and left running;
if none exists, adb daemonizes on **5037** and is deliberately left running as
known residue because other users may connect to it. The script never stops
an adb server. [adb](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/client/commandline.cpp)
and [emulator](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android/emu/adb/interface/src/android/emulation/AdbHostServer.cpp)
support `ANDROID_ADB_SERVER_PORT`, but
[Maestro 2.11.0's device lookup](https://github.com/mobile-dev-inc/Maestro/blob/cli-2.11.0/maestro-client/src/main/java/maestro/android/AndroidDeviceConnection.kt)
uses [dadb 2.0.0's fixed 5037 default](https://github.com/mobile-dev-inc/dadb/blob/v2.0.0/dadb/src/main/kotlin/dadb/adbserver/AdbServer.kt)
without reading the variable, so a task-specific port cannot be propagated
through all three tools. Before connecting with adb, the script queries the
shared server's protocol version over the smart socket and rejects a mismatch;
this avoids adb's automatic restart of incompatible servers.
Named screenshots are inside Maestro's per-flow `takeScreenshot` folder.
The script clears app data and waits for the resumed native
development-launcher activity before Maestro opens Metro; it does not depend
on the launcher's display text. A delayed System UI startup ANR was still
observed after these checks on a memory-constrained host. The launch flow waits
for the app or Android's ANR Wait button, then taps Wait once only when the
dialog title is exactly "System UI isn't responding". Application ANRs are
never dismissed and still fail the required app checks.

Maestro is intentionally **local-only for v1**. The CI follow-up is an
[EAS Workflows `type: maestro` job](https://docs.expo.dev/eas/workflows/pre-packaged-jobs/),
using a development build and fixture environment.

**Skipped:** the bypass-off sign-in screen check. Clerk's native `AuthView`
requires a real Clerk instance with Native API/app registration. The fixture
cannot render that container; no custom sign-in fields are tested or stubbed.
The script writes `signin-screen.skip.txt` so a green fixture run does not
imply live authentication coverage.

# Manual release workflow

`mobile-release.yml` runs only on `workflow_dispatch`, selects Android, iOS or
both, and runs `eas build --profile production --non-interactive --platform …`.
Auto-submit defaults to off; selecting it adds `--auto-submit`, which uses the
matching production submit profile. EAS CLI **24.8.0** is pinned in both
`eas-version` and the documented `cli.version` constraint in `eas.json`. Node
**24.21.0** matches the build profiles. The build/submit flags are documented in
the [EAS CLI reference](https://docs.expo.dev/eas/cli/) and the
[pinned CLI source](https://github.com/expo/eas-cli/blob/v24.8.0/packages/eas-cli/src/commands/build/index.ts);
see the [eas.json CLI configuration](https://docs.expo.dev/build/eas-json/#cli).

Before dispatch, the owner must:

1. Create the **production GitHub Environment**, enable required reviewers, and
   store `EXPO_TOKEN` as an Environment secret. The job uses
   `environment: production`, so reviewers approve access before it starts.
2. Set the **`EAS_PROJECT_ID` repository variable**. The workflow fails before
   tool setup when either this value or `EXPO_TOKEN` is empty.
3. Also define the same **`EAS_PROJECT_ID` in the production EAS environment**,
   along with the public release values and signing credentials. The GitHub
   variable configures the CLI checkout; the EAS environment configures remote
   builds and updates.
4. For auto-submit, configure store credentials and app records.

See [release configuration](../../../docs/mobile-development.md#release-configuration).
This workflow does not provision accounts or credentials. Local fixture smoke
does not verify EAS builds, signing, store submission, or live authentication.
