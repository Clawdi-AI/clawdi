# Mobile development

Status: the foundation is merged in PR 1610; Wave 2 is a merge candidate in
PR 1611. Wave 3 adds existing-entitlement Agent creation, deployment progress
and v2 billing reads; purchases remain unavailable.
`apps/mobile` contains the
Cloud-only v2 Expo app, Clerk verification/recovery flows, account-generation
fencing, and paginated read-only Agent/Session history. Hosted v1 legacy
configuration is intentionally not required by the mobile app. The compatibility
fixture below is historical V0 evidence; it is not a payment implementation,
native iOS/Android build, or real-device authentication proof.

## Foundation toolchain

The root workspace uses Bun `1.4.2` and a named `expo57` catalog for the
approved SDK 57 runtime exception. A bounded Bun 1.4.2 install generated the
root lock and a frozen reinstall passed. Mobile and Shared TypeScript 7 strict
checks, Biome, and iOS/Android Expo exports passed. `expo install --check`
still reports only the deliberate TypeScript 7 versus Expo's `~6.0.3` checker
expectation; TypeScript 7 remains an explicit project decision. Expo export is
Metro bundling evidence, not native compilation or store-readiness evidence.

The product uses SDK 57 / RN 0.86.3's default TypeScript declarations with
TypeScript 7 and `strict: true`. It does not opt into RN 0.86's alternative
`react-native-strict-api` export condition: the full product surface exposed
five incompatibilities in Gesture Handler, Router Link and FlatList props.
Removing only that condition passed the full Mobile typecheck; compiler
strictness and runtime versions were unchanged. RN 0.86.3's published package
maps `types` to `types/index.d.ts` and the opt-in condition to
`types_generated/index.d.ts`. The [RN migration guide](https://reactnative.dev/docs/strict-typescript-api)
describes the opt-in on pre-0.87 releases. The V0 strict-API probe below remains
historical evidence; it is not a claim that the product passes that opt-in gate.

## Develop and verify the product

Use the root `packageManager` (`bun@1.4.2`) and committed root lock. Common
versions belong in the root Bun catalog; SDK-constrained native packages use
`catalog:expo57`. Do not flatten the Web/Desktop and native React versions or
install an independent mobile lockfile.

Set `EXPO_PUBLIC_CLAWDI_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` for the
development build, then run:

```bash
bun run --cwd apps/mobile dev
```

Use a development build containing the project's native modules; Metro export
success does not establish Expo Go support. Done: Expo starts and the app shows sign-in; missing or invalid configuration
shows a safe configuration screen instead. Use a reachable Cloud API URL on
physical devices, not the development computer's `localhost`. These public
values are embedded in the app; never put private credentials in them. Clerk
email/password verification, recovery and supported second factors must be
configured by the account owner. This work does not change Clerk settings.

`EXPO_PUBLIC_CLAWDI_COMPUTE_API_URL` optionally enables the v2 compute control
plane. It is separate from the Cloud identity/Session API and does not enable
Hosted v1. A trailing `/v2` is normalized. An absent compute URL leaves Cloud
browsing available; an explicitly unsafe URL fails configuration validation.
The same captured-account token fence protects both API clients. No payment
keys, signing material or private infrastructure addresses belong in this
public configuration.

## Agent creation and billing boundaries

Each Agent has its own independent compute subscription. The mobile work does
not introduce an account-wide subscription slot or multi-Agent bundle. Included
Basic availability and reusable subscriptions come from the server, not local
assumptions. The server remains the final authority for capacity and assignment.

The current Basic deployment route can select Included Basic or an existing
funded, unbound subscription for regular users; only CLI principals enforce
Included-only admission. The client does not purchase compute or debit a Wallet
through that route. Its legacy-named `createIncludedDeployment` method rejects
non-Basic plans but cannot promise a specific existing entitlement. Creation
uses a persistent, account-scoped request key and explicit user confirmation;
mounting or restoring the app must never automatically replay a POST.

The saved journal records `prepared`, `uncertain`, or `entitlement_rejected`.
Persist `uncertain` before starting a POST. Only an unsubmitted draft or a first
submission rejected with the server's pre-admission `compute_entitlement_required`
can be explicitly discarded. A later rejection cannot resolve earlier uncertainty,
and a by-request 404 is never proof that no POST is in flight. Legacy journals
without a marker restore as uncertain. Storage compare-and-set prevents an old
screen from deleting another screen's in-flight marker. Explicit retries retain
the exact saved body/key and do not revalidate it against a changed model catalog.
New drafts still validate the current catalog; the server remains authoritative.

Creation reads current product capabilities from the existing `/v1/me` profile
route and uses only the generated capability booleans. Route versions are not
product generations: using this shared profile projection does not migrate the
legacy Hosted v1 UI. The Included availability response contains slot counts,
not capability flags, and catalog plans do not expose an `enabled` field.

The canonical create request id equals `Idempotency-Key`. This endpoint restricts
keys to 191 visible ASCII characters even though the generic header permits
255. If supplied, `deploy_request_id` must match the key. After an uncertain
response, reconcile the original request through the existing by-request API;
do not replace the key and create another Agent.

Subscription quotes are explicitly requested previews, not payments. They may
initialize and commit customer, enrollment and Wallet profiles. They do not
purchase or debit Wallet funds and must not be described as strictly read-only.
Current catalog prices and Stripe/Wallet quotes are not App Store/Play purchase
offers. Native purchases, top-ups, refunds, restore and subscription management
remain disabled until a reviewed provider-aware contract and authorized store
sandbox are available. Wallet-funded compute still uses Stripe invoice
orchestration; it is not a store-independent funding rail.

Run the isolated product suite from the repository root:

```bash
bun run --cwd apps/mobile test
```

Done: the clean Docker runner installs the frozen workspace lock, completes
the Mobile TypeScript 7 check, and reports passing tests without modifying
the checkout. `test:internal` is only for the disposable runner and CI.
`scripts/test.sh ci` also includes the Mobile tests.

The read surfaces use generated API types and account-fenced queries. Agent
inventory is virtualized; Sessions use explicit load-more and pull-to-refresh.
Agent-to-Sessions navigation uses the generated `environment_id` filter.
Session responses do not expose a stable Agent id, so no reverse link is
invented. Transcripts pin subsequent pages to the first response's content
revision, offer an explicit reset on a revision conflict, and distinguish
unuploaded content from a network error. Messages remain read-only and plain
text; this app does not send messages or embed a runtime UI.

After independent review corrected the Expo UI hosting contract, one bounded
Docker run passed the exact foundation's Mobile/Shared TypeScript 7, Biome
(32 files), 11 Mobile tests and independent iOS/Android Metro exports. In the
same disposable workspace, the full Wave 2 candidate passed all six workspace
typechecks, Biome (57 files), 22 Mobile tests (54 assertions), 125 Shared tests,
five runner contract tests and both platform exports. The container exited 0;
frozen install did not change the root manifest or lock. Separate resolution
checks against that lock found one Mobile React identity across eight peers.

Every native system button is wrapped in Expo UI's `Host`, with vertical
content sizing and full available width. The Universal Button adapters do not
create that native bridge themselves. Dark/light tokens retain UniWind's
documented root-scoped variants; their emitted Tailwind selectors were checked
separately from Metro. These are source/bundling checks, not proof of a native
build, visual layout, accessibility interaction or a live Clerk flow.

Wave 3 also wraps native system pickers and switches in the same bridge. Billing
and deployment lists are virtualized. Wallet USD decimals retain server precision;
subscription inventory and transactions use opaque cursor pagination. Subscription
detail does not infer absence from only the first page of account inventory.

The final Wave 3 candidate passed bounded Docker verification with Bun `1.4.2`
(registry latest at verification) and TypeScript 7: all six workspace typechecks,
Biome on 71 files with no writes, 37 Mobile tests (137 assertions), 130 Shared
tests (440 assertions), 84 focused Web regressions (394 assertions), and separate
iOS/Android Metro/Hermes exports. The final container exited 0, and the manifest
and frozen root lock remained unchanged. The post-export Mobile typecheck also
passed. Independent static review confirmed the native hosting contract and
the corrected durable-recovery boundaries; this is not a live-device acceptance.

## Device acceptance still required

On an authorized simulator/device build, verify:

1. Sign in, register/verify email, recover a password and complete enabled
   second factors. Unsupported factors/session tasks must show safe guidance.
2. Switch accounts during a pending read and sign out during a pending action;
   no previous account's data or navigation may leak into the new account.
3. Browse Agent/Session lists and transcript pages, including empty, offline,
   unavailable-content and revision-conflict states; test foreground recovery.
4. Check native tabs, deep links/back navigation, safe areas, dark/light modes,
   large text and screen-reader labels on both platforms.
5. With current server eligibility, confirm Basic creation against an existing
   entitlement, inspect its operation/deployment and navigate to its Cloud Agent.
   Lose connectivity or terminate the app after admission; recover the same
   stored request without a fresh key or an automatic replay.
   Verify explicit discard after proven first-send admission refusal and same-body
   replay after a saved managed model disappears from the current catalog.
6. Inspect Wallet balance, paginated transactions and subscription details.
   Missing compute configuration, invalid deep links and restricted accounts
   must show safe states. Native payment/management actions stay unavailable.

Done: record the device/OS and observed outcomes. No live authentication,
native compilation/signing, purchases or provisioning has been verified here.
RevenueCat and new paid Cloud Agent creation remain gated by the separate
reviewed store/capacity/backend contracts; a read-only UI does not satisfy them.

## Reproduce the compatibility gate

> HISTORICAL V0 - The probe and pending decisions below describe the original
> investigation. The product now uses the approved SDK 57 runtime exception
> and default native type policy documented above; original evidence is kept
> unchanged for reproducibility.

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
