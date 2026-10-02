# Mobile development

Status: Wave 1 implementation is in progress. `apps/mobile` now contains the
Cloud-only v2 Expo shell, Clerk authentication boundary, account-generation
fencing, and read-only Agent/Session surfaces. Hosted remains the v1 legacy
product and is intentionally not required by the mobile app. The compatibility
fixture below is historical V0 evidence; it is not a payment implementation,
native iOS/Android build, or real-device authentication proof.

## Wave 1 verification snapshot

The root workspace uses Bun `1.4.2` and a named `expo57` catalog for the
approved SDK 57 runtime exception. A bounded Bun 1.4.2 install generated the
root lock and a frozen reinstall passed. Mobile and Shared TypeScript 7 strict
checks, Biome, and iOS/Android Expo exports passed. `expo install --check`
still reports only the deliberate TypeScript 7 versus Expo's `~6.0.3` checker
expectation; TypeScript 7 remains an explicit project decision. Expo export is
Metro bundling evidence, not native compilation or store-readiness evidence.

## Reproduce the compatibility gate

Run from this checkout on Linux with Docker, GNU `timeout`, and UID 1000. No
backend, credentials, store configuration, signing, real login, or purchases are
needed. The probe uses Bun 1.4.0 and Node 24.21.0 in digest-pinned images. It copies
only the fixture into a container; the source mount is read-only. Installs use
the probe's committed locks, not the repository root lockfile, and skip package
lifecycle scripts. Native compilation is therefore not implied by installation.

```bash
bash apps/mobile/compatibility/run.sh latest
bash apps/mobile/compatibility/run.sh supported-diagnostic
```

Each command runs separately, with 2 CPUs, 4 GiB RAM, no swap allowance, 256 PIDs,
a 25-minute container deadline, and seven-minute check deadlines. Temporary
containers and derived images are removed on exit. Runtime caches and installed
dependencies disappear with the container. No persistent volumes are created;
shared Docker build caches are not pruned. Output goes to the ignored
`apps/mobile/compatibility/.artifacts/<profile>/` directory. Preserve needed
evidence, then remove only that task-owned directory.

At the time of the V0 probe, both commands exited 1 and produced `summary.json`
with the check outcomes below. A reproduced failure is not a passed product gate.
The registry check rejects a snapshot that no longer matches stable `latest`
tags; re-review versions rather than automatically replacing the lock.

## Observed versions

Registry and source observations were collected on October 1, 2026, PT, against
Clawdi `6705dd9a33ecf5432b3b26cd7b7255e0e17fc31c`. Machine evidence keeps UTC timestamps
for matching logs. The exact full dependency inventory, including Expo platform
services, is in the [fixture manifest](../apps/mobile/compatibility/fixture/package.json).
It is an observation and blocked dependency request, not permission to install
those versions into a product workspace.

| Package | Individually latest stable | SDK 57 diagnostic resolution |
| --- | --- | --- |
| Expo | 57.0.26 | 57.0.26 |
| Expo Router | 57.0.24 | 57.0.24 |
| Expo UI | 57.0.21 | 57.0.21 |
| React / React DOM | 19.3.0 / 19.3.0 | 19.2.3 / 19.2.3 |
| React Native | 0.87.1 | 0.86.3 |
| TypeScript | 7.0.2 | 7.0.2, intentionally retained |
| React types | 19.3.0 | 19.2.18 |
| Babel core | 8.0.6 | 7.29.7 |
| RN Metro config | 0.87.1 | 0.86.3 |
| HeroUI Native | 1.0.10 | 1.0.10 |
| UniWind | 1.12.1 | 1.12.1 |
| Clerk official Expo SDK | `@clerk/expo` 4.8.0 | 4.8.0 |
| Gesture Handler | 3.3.0 | 2.32.0 |
| Reanimated | 4.7.0 | 4.5.1 |
| Worklets | 0.13.0 | 0.10.1 |
| Safe Area Context | 5.10.1 | 5.7.0 |
| Screens | 4.28.0 | 4.26.2 |
| SVG | 15.15.5 | 15.15.4 |
| Bottom Sheet, optional HeroUI peer | 5.2.14 | 5.2.14 |
| Expo Blur, optional HeroUI peer | 57.0.3 | 57.0.3 |
| Tailwind CSS / Variants / Merge | 4.3.3 / 3.3.1 / 3.7.0 | unchanged |
| React Query | 5.104.0 | 5.104.0 |
| i18next / react-i18next | 26.4.2 / 17.0.15 | unchanged |

SDK 57's installed `bundledNativeModules.json` expects RN 0.86.3, React 19.2.3,
the diagnostic native peers, Babel `^7.29.0`, React types `~19.2.4`, and TS
`~6.0.3`. The official default template 57.0.28 supplies the core/runtime tuple;
its React-types range is older than the installed SDK recommendation, so the
diagnostic explicitly follows the latter. TS7 is not substituted with TS6.

The registry's Expo `next` tag is 58.0.2, despite its numeric stable-looking
version. The [official September 15 release announcement](https://expo.dev/changelog/sdk-58-beta)
still identifies SDK 58 as beta and instructs installing `expo@next`; the
[release index](https://expo.dev/changelog) and `latest`/`sdk-57` tags identify
57 as the stable channel. SDK 58 is not an approved alternative in this probe.

`@clerk/clerk-expo` 2.20.0 is deprecated; current official interfaces come from
`@clerk/expo` and `@clerk/expo/token-cache`. Clerk 4.8.0 declares Expo `>=54 <58`.
RevenueCat purchases and purchases UI were observed at 10.11.0, but are not
installed or invoked: both eventual funding journeys remain separately gated.

## Check evidence

The fixture includes Expo Router's native stack, Expo UI Universal `Host`/form
controls, and HeroUI cards/chips/spinner with UniWind's documented Metro wrapper.
It imports Clerk/token-cache/React Query modules into the bundle graph without
mounting `ClerkProvider` or requesting tokens. SDK-derived token-cache/get-token
types are checked; this does not test login, secure persistence, or sign-out.

| Check | All latest | Supported diagnostic |
| --- | --- | --- |
| Frozen install and second frozen install | pass | pass |
| Single React identity from Expo/RN/Router/Clerk/HeroUI | pass | pass |
| Expo dependency check | fail, 12 mismatches | fail, TS7 vs SDK's TS6 only |
| Expo Metro polyfill resolution | fail | pass |
| Generated UniWind declarations | pass | pass |
| Strict gallery typecheck, automatic RN `className` | fail | fail |
| Strict official `withUniwind` + Clerk/Query contracts subset | pass | pass |
| Independent iOS Metro/Hermes export | fail | pass |
| Independent Android Metro/Hermes export | fail | pass |
| Android native compilation | not run | not run |
| iOS native compilation | not run | not run |

Failures are distinct:

- Expo 57's Metro serializer calls `react-native/rn-get-polyfills`, which RN
  0.87.1 no longer ships. The focused `expo-polyfills` check reproduces this
  independently of transformation failures. No RN internals are patched.
- Both all-latest platform exports fail in HeroUI's slider/Worklets path: Babel's
  TypeScript preset requires Babel 7 but receives application Babel 8.0.6.
  Expo Metro's own nested Babel is 7.29.7; that does not fix the root transformer.
- HeroUI 1.0.10 requires Gesture Handler `^2.28.0`, excluding latest 3.3.0.
  Installation success is not peer compatibility evidence.
- UniWind's generated augmentation does not add `className` to the strict RN
  `View`/`Text` props, even with RN 0.86.3. Both raw failures remain in the fixture.
  The [official `withUniwind` API](https://docs.uniwind.dev/api/with-uniwind)
  passes a separate strict subset without casts, prop augmentation, disabling
  strict API, or changing TS7. That subset is not a complete gallery/app check.
- Bottom Sheet's raw peer range `>=3.16.0 || >=4.0.0-` is rejected by the installed
  semver parser. It is recorded as malformed vendor metadata, separately from a
  proven version conflict; it is not silently normalized or peer-ignored.

Committed [evidence](../apps/mobile/compatibility/evidence/) includes both locks,
registry metadata/integrities/channels, installed/source/peer audits, exact
check exits, and platform/type/dependency logs. Exported bundles and caches are
not committed. Native exports are **not native builds**, and do not establish
runtime UI, authentication, gestures, accessibility, or store compatibility.

## Exception evidence and pending gates

The diagnostic applies the **complete SDK 57-recommended core/native tuple**
plus Babel 7.29.7, RN Metro 0.86.3, and React types 19.2.18. It intentionally
retains TS7 instead of Expo's recommended TS6, so it is not an entirely
Expo-supported compiler/tooling tuple. The checker reports that deviation.

Individually established conflicts are RN 0.87.1's removed polyfill path,
Babel 8's incompatible preset/Worklets transformation, and HeroUI's exclusion
of Gesture Handler 3.3.0. The tested candidate replacements are RN 0.86.3,
Babel 7.29.7, and Gesture Handler 2.32.0 **within the complete diagnostic**.
No successful minimal rollback set has been established: React and the other
native peer substitutions were not tested one at a time. Do not present the
complete diagnostic as proof that every rollback is necessary or sufficient.

The concrete owner decision request is approval of that complete native/runtime
exception tuple, while retaining stable UI/Router/HeroUI/UniWind/Clerk and TS7,
or rejection of those substitutions pending stable vendor compatibility.

Approval has not been granted. No root native dependency install is requested
until that decision. If an exception is rejected, retain the reproducible
failure and wait for a verified stable vendor combination. Do not select Expo
beta, downgrade TS, ignore peers, or suppress strict types to pass the gate.

An approved foundation must then:

1. Apply the official typed UniWind integration to the full gallery and obtain a
   complete TS7 pass. Resolve the SDK checker/TS7 support decision explicitly;
   the current checker still exits 1 and is not suppressed.
2. Have root integrate and lock product dependencies. Use the shared generated
   `@clawdi/shared/api` clients supplied by the API owner; C supplies `expo/fetch`,
   Clerk token access, generation aborts, and account-scoped cache lifecycle.
   Do not duplicate API/domain types or modify Web/Electron React selections.
3. Verify React identity and Metro resolution again in the real monorepo, not
   just this isolated fixture. Implement and test bounded account/auth/AppState/
   network/query lifecycle, translations/themes, and real native navigation.
4. Compile native Android and iOS independently, then verify device/simulator
   behavior. This Linux container has no Android SDK or Apple/Xcode runner.
   Signing, uploads, live login/store operations require separate authorization.
5. Keep Sessions browsing-only. Money/provisioning remains owned by the hosted
   control plane; capacity/refunds/debt/transfers/product mappings are unresolved.
   Neither direct IAP nor Wallet top-ups may bypass those gates.

For the SDK 57 candidate, Expo/Expo Modules Core/Expo UI podspecs require **iOS
16.4** (not RN's lower 15.1 floor); RN's Android catalog declares **API 24**
(Android 7), compile/target API 36. iPhone/iPad, iOS simulators, Android phones/
tablets/emulators, OS-floor coverage, large text and assistive technology are
pending, not a tested device matrix. No product minimum OS selection is frozen.

## Verify probe source

```bash
bash apps/mobile/compatibility/run.sh verify-source
```

Done: containerized Node syntax checks, Bash syntax checks, and the repository's
Biome 2.5.14 configuration exit 0, reporting `Checked 15 files` without fixes,
including `fixture/wrapped.tsx`. In that same container, temporary synthetic
summary inputs with zero check exits and no peer conflicts return exit 0 for
`singleReactIdentity: true`, and exit 1 for false or an omitted identity marker.
Root workspace typecheck/CI/native-build integration remains root-owned; this
probe does not register a product workspace or change root manifests/locks.
