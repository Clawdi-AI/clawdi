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
Only this emulator's Metro port is mapped with `adb reverse` so the client
can use the server's localhost manifest and bundle URLs. Expo's upstream
headless mode disables the desktop DevTools installer.
The manifest and JavaScript come from Metro with development-only auth bypass
and both API URLs pointing at `10.0.2.2:8796`. No Clerk key or real account is
used. Maestro 2.11.0 is downloaded from its official release, checked against
the publisher's SHA-256, and extracted only into a disposable task directory.
For retries or offline runs, `--maestro-archive /path/to/maestro.zip` reuses a
previously downloaded official ZIP with the same pinned checksum validation.

`smoke.yaml` runs launch, Home → Agent detail, Agents → another Agent detail,
Sessions → fixture transcript, Library → project bundle, and Account → API
keys. Each detail check asserts fixture content. Maestro is limited to ten
minutes, service readiness/install/downloads have separate bounds, and exit
traps stop only processes started by this run, including on failure or
interruption. The emulator receives its own shutdown signal so SDK helpers
can exit normally; netsimd is never signaled. Runtime files are removed. Logs,
JUnit results and screenshots remain under a unique ignored
`test-results/mobile-e2e.*` directory; `--output`
can select a new directory. No adb server/netsimd shutdown is performed.
Named screenshots are inside Maestro's per-flow `takeScreenshot` folder. The launch
flow waits for the native development launcher before opening Metro. If the
AVD cold boot shows Android's "System UI isn't responding" dialog, it selects
"Wait" once; application ANRs still fail the smoke.

**Skipped:** the bypass-off sign-in screen check. Clerk's native `AuthView`
requires a real Clerk instance with Native API/app registration. The fixture
cannot render that container; no custom sign-in fields are tested or stubbed.
The script writes `signin-screen.skip.txt` so a green fixture run does not
imply live authentication coverage.

# Manual release workflow

`mobile-release.yml` runs only on `workflow_dispatch`, selects Android, iOS or
both, and runs `eas build --profile production --non-interactive --platform …`.
Auto-submit defaults to off; selecting it adds `--auto-submit`, which uses the
matching production submit profile. These flags are documented in the
[EAS CLI reference](https://docs.expo.dev/eas/cli/).

Before dispatch, the owner must configure the `EXPO_TOKEN` repository secret,
the `EAS_PROJECT_ID` repository variable, production EAS environment values
and signing credentials. Auto-submit additionally needs store credentials
and app records. See [release configuration](../../../docs/mobile-development.md#release-configuration).
This workflow does not provision accounts or credentials. Local fixture smoke
does not verify EAS builds, signing, store submission, or live authentication.
