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
Agents → hosted Agent hub rows (Tools, Settings) → Files state page,
Sessions → fixture transcript, Library → project bundle, Account → settings
menu → General and API Keys, and finally the Overview bell → notification inbox
→ back, asserting the badge drops from four to two once opening marks the
account updates read. The flows use loaded fixture entity IDs, including a transcript message.
Native tab Triggers retain test IDs. On Android, react-native-screens 4.26.2
exports those IDs only as Espresso View tags, so Maestro uses short tab labels
scoped to native Material tab items by their container, with no index selectors. The flows
cite the upstream limitation. Settings menu rows use `settings-row-<panel>` test IDs and Agent hub rows use
`agent-section-<section>`;
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

## Nightly and manual CI

After these workflows land on `main`, trigger the GitHub **Mobile E2E** workflow:

```sh
gh workflow run mobile-e2e.yml --ref main
```

It also runs nightly at **2:23 AM PDT / 1:23 AM PST** (09:23 UTC). The preflight
exits successfully with a `SKIP` summary when either the **`EXPO_TOKEN` repository
secret** or **`EAS_PROJECT_ID` repository variable** is absent. The owner must
supply an Expo project UUID, a token authorized for that project, and an EAS
plan that supports Maestro jobs. Expo's current [pricing](https://expo.dev/pricing.md)
lists Maestro jobs on paid plans; the Free plan's 60 workflow minutes do not
include Maestro jobs. This workflow does not provision accounts or credentials.

GitHub invokes `apps/mobile/.eas/workflows/e2e-android.yml` from the checked-out
source with EAS CLI **24.8.0**. Uploading local source with `workflow:run` avoids
requiring a GitHub/EAS repository connection. The official [`get-build` job](https://docs.expo.dev/eas/workflows/pre-packaged-jobs/#get-build)
is configured to reuse a successful internal Android APK only when its `e2e`
profile and commit match. **APK reuse by commit is unverified until the first
owner run**; confirming reuse also requires a repeat run of that commit. A cache
miss builds `e2e`, which extends `development` and uses documented
[`withoutCredentials`](https://docs.expo.dev/build/eas-json/). Development clients
[default to `:app:assembleDebug`](https://github.com/expo/eas-cli/blob/v24.8.0/packages/build-tools/src/steps/utils/android/gradle.ts#L70-L83),
so no Gradle command override is needed. The build job inherits the profile's
`development` environment. It uses Android debug
signing, needs no Play/Apple credentials, and disables Sentry uploads. A changed
commit is configured to cause a new native build to avoid stale native modules.

The official [`type: maestro` job](https://docs.expo.dev/eas/workflows/pre-packaged-jobs/#maestro)
owns the emulator, APK installation and Maestro 2.11.0. Its
`linux-large-nested-virtualization` worker follows Expo's recommendation to use
larger workers for newer emulator images such as the selected Android 36 image.
Flows reference `${MAESTRO_APP_ID}` and `${MAESTRO_DEV_CLIENT_URL}` directly:
Maestro forwards `MAESTRO_*` environment variables without stripping the prefix.
The local harness passes these same names with `-e`. The
`before_maestro_tests` hook installs frozen dependencies and runs
`scripts/mobile-e2e-eas.sh start` in the same VM. That script starts the existing
fixture API on 8796 and one Metro worker on 8096, waits for HTTP readiness and
the native development launcher, and uses the same `.maestro/smoke.yaml` as the
local harness. Android reaches the fixture through its documented
[`10.0.2.2` host alias](https://developer.android.com/studio/run/emulator-networking#networkaddresses)
and Metro through an adb reverse rule. Metro supplies the development-only
auth bypass and app configuration; a release APK cannot enable that bypass.
No public fixture deployment, tunnel, production API or live Clerk account is
needed by this design. Background service survival across hook shells relies on
the pinned **eas-cli 24.8.0 implementation**, rather than a documented service
lifecycle guarantee: [`BuildStep.executeCommandAsync`](https://github.com/expo/eas-cli/blob/v24.8.0/packages/steps/src/BuildStep.ts#L440-L490)
awaits the shell process with piped output, and its
[`spawnAsync` wrapper](https://github.com/expo/eas-cli/blob/v24.8.0/packages/steps/src/utils/shell/spawn.ts)
does not explicitly clean up descendants after a successful shell exit. The
helper uses separate process groups and redirects all service stdio. **The first
owner-run green is the acceptance proof** that services survive across hooks on
the EAS worker and the fixture-backed smoke completes.

Once the before hooks succeed, `after_maestro_tests` uses `always()` to stop the
owned service process groups, remove the adb reverse rule and upload service
logs, including after a Maestro test failure. **A before-hook failure skips the
after hooks**, so it cannot rely on their cleanup or artifact upload. A failed
`start` prints the last 80 lines of available fixture/Metro logs to the step
output and stops its owned services. Services also expire after 20 minutes if
the hook is interrupted.

Done: after owner setup, the GitHub job and EAS `smoke` job are green. Follow the
EAS run link in the GitHub summary: **Maestro Test Results** contains JUnit,
named screenshots and debug output; **fixture-service-logs** contains fixture,
Metro and launcher logs when the after hooks are reached. Before-hook failures
have step output instead of that log artifact. GitHub waits up to 75 minutes for
the run and allows up to 10 minutes to cancel and observe an unfinished run's
terminal status after failure/interruption. Cloud execution, APK reuse and
artifact collection require owner-run verification; local schema validation
does not establish a green EAS run.

For owner-side server validation from `apps/mobile`:

```sh
bunx eas-cli@24.8.0 workflow:validate .eas/workflows/e2e-android.yml --non-interactive
```

This CLI command requires an authenticated Expo project. Without credentials,
validate against the public [official workflow schema](https://api.expo.dev/v2/workflows/schema);
server validation remains pending.

| Option | Fixture and artifacts | Cost/runtime considerations |
| --- | --- | --- |
| EAS Workflows (implemented) | Official Maestro hooks are configured to run fixture/Metro on the test VM; EAS uploads results and service logs once the after hooks are reached. First owner-run green is pending. | `linux-large-nested-virtualization` is $0.040/minute, plus $0.05 per Maestro job. Cache misses add the Android medium build's $1 flat rate, after any included credits. Queue, install, build and test time determine the total; cloud duration is unmeasured. |
| GitHub Actions with KVM (alternative) | A Linux runner can create an AVD, obtain/cache a development APK and run `scripts/mobile-e2e.sh`; `actions/upload-artifact` can upload its output. | GitHub [documents Android hardware acceleration](https://docs.github.com/en/actions/reference/runners/github-hosted-runners); the [emulator runner action](https://github.com/ReactiveCircus/android-emulator-runner#running-hardware-accelerated-emulators-on-linux-runners) documents KVM setup. Runner minutes/quotas and native build costs apply; SDK, AVD and APK caching need separate maintenance. |

Rates above are from Expo's current pricing page; check it before enabling the
nightly schedule. GitHub's preflight and waiting job use the standard
`ubuntu-latest` runner with the existing platform-generic `setup-bun-ci` action,
also configured on that runner in `desktop-update-site.yml`. Native builds and
the emulator run on EAS. The waiting job also consumes GitHub minutes; a long
EAS queue/build can exceed its 75-minute wait budget. The existing local
`scripts/mobile-e2e.sh` remains available.

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
