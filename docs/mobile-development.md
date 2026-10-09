# Mobile development

`apps/mobile` contains the Cloud-only v2 Expo app. Thin Expo Router routes in
`app/` render `src/pages/`, with feature UI in `src/components/` and v2 hosted
surfaces in `src/hosted/`. Domain clients, view models and Web copy come from
`@clawdi/shared`; native auth, navigation, storage and store SDKs live in
`src/platform/`. Mobile copy lives in `src/lib/i18n/`.

Sign-in and account management use Clerk native UI. `/settings` is a grouped
native menu that pushes General, Account, API Keys, Wallet, Compute and AI Usage
(the last three require a compute API), followed by Help and legal links.
RevenueCat Paywalls sell consumable
Clawdi Credits into the hosted Wallet; pending purchases have explicit recovery.
Consumable credits cannot be restored. Customer Center management is planned
for store subscriptions and is not wired in the current app. New paid compute
subscriptions remain unavailable in the deployment wizard; it deploys with Included
Basic, an exact reusable card/Wallet subscription (Web's `existing` selection),
a store subscription, Clawdi AI, a saved AI provider, or configuration inside the
agent. Card/Wallet subscriptions can be cancelled, end a trial or drop a scheduled
plan change in every build; resume appears only outside store builds. Agent overview rows
reach every section; Files opens through the hosted one-time browser handoff,
while Terminal uses Expo DOM. See
[UI parity](../apps/mobile/UI-PARITY.md) and
[store compliance](mobile-store-compliance.md) for platform boundaries and
gates.

Hosted v1 configuration is not required. The compatibility fixture at the end
is historical V0 evidence, not a native-build or real-device acceptance claim.

## Foundation toolchain

The root workspace uses Bun `1.4.2` and a named `expo57` catalog for the
approved SDK 57 runtime exception. A bounded Bun 1.4.2 install generated the
root lock and a frozen reinstall passed. Mobile and Shared TypeScript 7 strict
checks, Biome, and iOS/Android Expo exports passed. TypeScript 7 remains an
explicit project decision; `apps/mobile/package.json` records it in
`expo.install.exclude` so Expo's dependency checker validates the SDK packages
without requiring its expected TypeScript `~6.0.3`. Expo export is
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

Native application types and Bun test types use separate strict TypeScript
programs. `apps/mobile` typecheck runs both `tsconfig.json` and
`tsconfig.test.json`; Bun-only global Blob extensions must not leak into native
file APIs. Tests remain typechecked, not excluded from verification.

Mobile typecheck first runs the official offline `expo customize tsconfig.json`
command to generate Expo Router types without starting a dev server. The native
program includes `.expo/types/**/*.ts` and `expo-env.d.ts`; both generated paths
are ignored. An isolated negative compilation confirmed that the nonexistent
`/skills/[skillId]` route fails with TS2322, while the actual `/skills/detail`
Project/key navigation passes. The temporary negative fixture is not shipped.

## Develop and verify the product

Use the root `packageManager` (`bun@1.4.2`) and committed root lock. Common
versions belong in the root Bun catalog; SDK-constrained native packages use
`catalog:expo57`. Do not flatten the Web/Desktop and native React versions or
install an independent mobile lockfile.

Import Lucide runtime icons from the official per-icon entries, for example
`import Camera from "lucide-react-native/icons/camera"`, to keep Metro from
bundling unused icons. Type-only imports can use the package entry point. See
[Lucide's React Native optimization guide](https://lucide.dev/guide/react-native/advanced/optimizations).

Set `EXPO_PUBLIC_CLAWDI_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` for the
development build, then run:

```bash
bun run --cwd apps/mobile dev
```

Use a development build containing the project's native modules; Metro export
success does not establish Expo Go support. Done: Expo starts and the app shows
sign-in; missing or invalid configuration shows a safe configuration screen
instead. Use a reachable Cloud API URL on physical devices, not the development
computer's `localhost`. These public values are embedded in the app; never put
private credentials in them. Sign-in methods, verification and second factors
are Clerk Dashboard settings owned by the account owner (see
[Clerk native authentication](#clerk-native-authentication)).
This work does not change Clerk settings.

### Local fixture authentication

For UI parity against the local fixture API on port 8787, run the real mobile
dashboard with development authentication bypass:

```bash
EXPO_PUBLIC_DEV_AUTH_BYPASS=1 \
EXPO_PUBLIC_CLAWDI_API_URL=http://10.0.2.2:8787 \
bun run --cwd apps/mobile dev
```

`10.0.2.2` reaches the development host from the Android emulator. No Clerk
publishable key is required in this mode; the Cloud API URL is still required
and validated. All real providers, account fencing, screens and API clients run.
The bypass identity is `dev_browser` with session `dev_browser_session`.
Optional `EXPO_PUBLIC_DEV_AUTH_NAME`, `EXPO_PUBLIC_DEV_AUTH_EMAIL` and
`EXPO_PUBLIC_DEV_AUTH_TOKEN` default to `Avery Chen`, `avery@clawdi.dev` and
`dev-bypass`. These are public fixture values, not credentials for a live API.

The fixed fixture identity cannot sign out. Clerk's native sign-in/sign-up and
account management views need `ClerkProvider`, so they show an EmptyState.
Restart Metro when changing public environment values.
The flag requires `__DEV__`; production exports remove the bypass identity and
token even when `EXPO_PUBLIC_DEV_AUTH_BYPASS=1` is set. Real Clerk authentication
and its account/session request fencing remain in use for production builds.

Done: with the fixture API running, the Android development build opens the
real Home tab without Clerk sign-in and loads fixture data through the Cloud API.

For local Android previews, reuse the shared development-client APK:

```bash
CLAWDI_ANDROID_DEV_APK="${XDG_CACHE_HOME:-$HOME/.cache}/clawdi/android-preview/apk/clawdi-dev.apk"
scripts/mobile-e2e.sh --apk "$CLAWDI_ANDROID_DEV_APK"
```

Read the APK directory's `README.md` before using it. The APK contains native
modules and loads JavaScript from the current worktree's Metro server; no
fixture API is baked into it. Rebuild it when native modules change, not for JS
or copy edits. The smoke script checks the app identity and dev-client manifest
before installing.

For bounded Android automation, run `scripts/mobile-e2e.sh --apk <development.apk>`
from the repository root. The APK must contain `expo-dev-client`; the script
loads the current worktree from Metro with fixture authentication. It uses an
existing read-only AVD on port 5564, fixture API 8796 and one Metro worker on
8096, and cleans up its processes on exit. See the
[Maestro smoke guide](../apps/mobile/.maestro/README.md) for prerequisites,
coverage, artifacts, the skipped live Clerk check, nightly/manual EAS fixture
smoke and manual release CI.

For iOS simulator verification, run the manual
[EAS iOS fixture smoke](../apps/mobile/.maestro/README.md#manual-ios-simulator-smoke-in-eas).
It runs the shared Maestro smoke and worker-local fixture/Metro in EAS cloud,
without using the owner's Mac. EAS project credentials and a Maestro-capable
plan are required; the first cloud run remains the acceptance check.

### Development galleries and production exports

`/dev/ui` and `/dev/account` load their implementation with a literal
`__DEV__` conditional `require`. Expo's documented
[development-code removal](https://docs.expo.dev/guides/tree-shaking/#remove-development-only-code)
folds that condition before collecting dependencies in SDK 57. Production keeps
only redirect route stubs; `src/pages/dev/` and its gallery-only imports are
absent from the bundle graph. A layout or page redirect alone does not exclude
imports.

From `apps/mobile`, verify the exported graph and gallery markers:

```bash
mobile_exports=$(mktemp -d)
trap 'rm -rf "$mobile_exports"' EXIT
bunx expo export --platform all --no-bytecode --source-maps --output-dir "$mobile_exports"
python3 - "$mobile_exports" <<'PYCODE'
import json
import sys
from pathlib import Path
root = Path(sys.argv[1]) / "_expo/static/js"
for platform in ("ios", "android"):
    maps = list((root / platform).glob("*.map"))
    assert maps, f"Missing {platform} sourcemaps"
    for path in maps:
        sources = json.loads(path.read_text())["sources"]
        assert not any("/src/pages/dev/" in s.replace("\\", "/") for s in sources)
    bundles = list((root / platform).glob("*.js"))
    assert bundles, f"Missing {platform} bundles"
    for path in bundles:
        assert not any(marker in path.read_text() for marker in ("UI gallery", "csub_fixture"))
    print(platform, sum(path.stat().st_size for path in bundles), "bytes; galleries excluded")
PYCODE
```

Done: both platforms print `galleries excluded`. Check source membership as well
as text markers: minification already removes many gallery strings even when
its imports remain. `expo export --dev` must retain both gallery implementations.

### Clerk native authentication

Sign-in, sign-up and account management use Clerk's prebuilt native components
from `@clerk/expo/native` (clerk-ios / clerk-android), matching Web's Clerk
`<SignIn/>`, `<SignUp/>` and `openUserProfile`:

- `/sign-in` and `/sign-up` render the same non-dismissible `AuthView` in Clerk's
  default `signInOrUp` mode: the native `signIn`/`signUp` modes have no link to
  each other, so a new user on `/sign-in` or an existing user arriving from a Web
  `/sign-up` link would be stuck. It offers every method enabled in the Clerk
  Dashboard: email/phone codes, password, OAuth, Sign in with Apple, passkeys and MFA.
  Social sign-in uses the native SDK flows, so the app registers no custom
  `clawdi://` OAuth callbacks.
  The `(auth)` layout leaves only when the session is active and
  `useAuthViewState()` reports the native flow (session tasks, biometric
  enrollment) complete, then returns to a validated `publicShareId` or Home.
- Settings → Account opens `/settings/account`, which renders
  `UserProfileView` with Clerk's own chrome (`onHostBack` pops the route). It
  covers profile, emails, phones, password, MFA, passkeys, connected accounts,
  active sessions, sign-out and account deletion. Sign-out is synced to the JS
  SDK; the auth gates route to `/sign-in` and `AccountScopeProvider` retires the
  account scope and its query cache.
- Account deletion follows the Clerk instance setting "allow users to delete
  their accounts", as on Web. While it is enabled, Clerk's built-in delete is
  shown and Hosted cleans up on the verified Clerk deletion webhook. When it is
  disabled (`user.deleteSelfEnabled === false`), a `customPages` row "Delete
  account" (`src/hosted/account/delete-account-page.tsx`) replaces it: it shows
  the App Store / Google Play billing notice, confirms with the system alert,
  calls Hosted `DELETE /v1/me` once (no automatic retry) and signs out. When
  Clerk rejects the sign-out of the deleted user (clerk-js then leaves the
  session in its transitive `undefined` state), it clears the session locally
  with Clerk's documented `setActive({ session: null })` and waits for the
  change through `addListener` (10 s bound).
  Disable self-delete before store auto-renewing subscriptions ship.
  On Android, clerk-android 1.1.10/1.1.11 crashes right after a successful
  built-in delete (`NavDisplay backstack cannot be empty`); the fix
  (clerk/clerk-android #1010) is unreleased, so the Android store gate stays
  closed until `@clerk/expo` pins a clerk-android release that contains it.
  The custom page counts as an alternative only after an owner-run check: on a
  real device, with self-delete disabled, a real deletion against a dev hosted
  environment returns to sign-in. That check has not happened yet.

The native views are **Beta** in `@clerk/expo` 4.8.0 and need a development
build (not Expo Go). The `@clerk/expo` config plugin raises the iOS deployment
target to 17.0, adds the Sign in with Apple entitlement and Android packaging
and Kotlin settings, and embeds `clerk-theme.generated.json`. `bun run theme`
generates that theme from the shared Web tokens (OKLCH → sRGB via culori);
`design.fontFamily` (Geist) applies on iOS only. The user's light/dark choice
reaches the native views through Uniwind's `Appearance.setColorScheme` call.
iOS associates `webcredentials:<Frontend API host>` for passkeys. The host is
decoded from `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` at config time (nothing is added
when the key is unset), so each build's key must belong to the Clerk instance whose
Dashboard → Native applications lists that iOS app; that Frontend API host is the
domain serving the passkey association.

Clerk Dashboard prerequisites (owner):

- enable the **Native API**;
- register the iOS app (Team ID + `ai.clawdi.app`) and the Android app
  (package + SHA-256 signing fingerprints);
- configure native Google client IDs and the Apple provider for social sign-in;
- turn "allow users to delete their accounts" off before store subscriptions
  ship.

If the native views cannot ship on a platform, the official fallback is
`useHostedAuth()` (Clerk Account Portal in a browser session), not custom forms.

### Clerk dashboard setup (owner)

Production uses a Clerk production instance and its `pk_live_` publishable key.
App Review 4.8 requires Sign in with Apple on iOS whenever another social
sign-in is offered. In the Clerk Dashboard:

1. **SSO connections** → **Add connection** → **For all users** → **Apple**,
   then enable it for sign-up and sign-in. Native iOS Apple sign-in does not
   need an Apple Services ID or private key; browser-based Apple OAuth does.
2. **Native applications**: register the iOS app (Team ID and bundle ID) and
   the Android app (namespace and package name).
3. Enable the Native API and configure native Google client IDs and the Apple
   provider. Clerk native UI owns social sign-in; the app registers no custom
   OAuth callback routes.

### App icon and splash screen

`bun run --cwd apps/mobile icons` renders the brand artwork
`docs/images/logo.png` (800px master; Web ships the same artwork at 512px) into
`apps/mobile/assets/`. Sizes above 800px are Lanczos3 upscales of the same
artwork. Outputs: the full-bleed opaque 1024px `icon.png`; the Android adaptive
foreground `adaptive-icon.png`, scaled so the face stays inside the 66dp safe
zone, on the artwork's red; the themed-icon layer
`adaptive-icon-monochrome.png`, which is the cream line art keyed off the red;
and the rounded-square `splash-icon.png`, used in both themes. `assets/app-colors.json`
holds the artwork red and the shared `--background` tokens used as splash
backgrounds; `app-icons.test.ts` fails when the token colors are stale. The
root layout holds the native splash until the stored appearance is applied, so
the first frame already uses the right theme. Icon and splash changes need a new
native build.

`EXPO_PUBLIC_CLAWDI_COMPUTE_API_URL` optionally enables the v2 compute control
plane. It is separate from the Cloud identity/Session API and does not enable
Hosted v1. A trailing `/v2` is normalized. In development, an absent compute URL
leaves Cloud browsing available; an explicitly unsafe URL fails configuration validation.
The same captured-account token fence protects both API clients. No payment
keys, signing material or private infrastructure addresses belong in this
public configuration.

## Agent creation and billing boundaries

Each Agent has its own independent compute subscription. The mobile work does
not introduce an account-wide subscription slot or multi-Agent bundle. Included
Basic availability and reusable subscriptions come from the server, not local
assumptions. The server remains the final authority for capacity and assignment.

The deployment route can select Included Basic or an existing funded, unbound
Basic/Performance subscription for regular users; only CLI principals enforce
Included-only admission. The client does not purchase compute or debit a Wallet
through that route. Shared `createEntitledDeployment` supports both generated plan
slugs; the existing `createIncludedDeployment` remains a Basic-only compatibility
wrapper. Native creation now lets the user select the plan, not a subscription ID:
the wire contract delegates matching entitlement selection to the server. Reusable
inventory is paginated with explicit load-more, and refreshed before new admission;
an Included Basic slot never authorizes Performance. A saved request remains
replayable even if its capacity was consumed by its original admission. Creation
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
offers. Store builds add credits through the official RevenueCat Paywall. The
hosted purchase attempt is created before opening the Paywall, and Hosted
confirms the completed transaction before applying funding. Pending purchases
can be checked explicitly. Consumable credits cannot be restored; Customer
Center subscription management is not wired yet. Store sandbox acceptance
remains a release gate. Wallet-funded compute still uses Stripe invoice
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
unuploaded content from a network error. Messages remain read-only and render
native Markdown. The app does not send messages; Terminal uses an Expo DOM
view, and Files opens in the system browser.

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

The current mobile parity batch adds Memory creation/editing/deletion and ranked
search, builtin/Mem0 provider settings, user-created Project creation/editing/
archiving, and safer API key management. Account changes reset local drafts;
destructive confirmations retain the captured account scope. Raw API keys and
Mem0 input are transient and cleared on backgrounding. Dashboard statistics now
participate in pull-to-refresh and expose loading/error states.

[Project sharing](../apps/mobile/src/components/sharing/share-project-dialog.tsx)
now includes owner-managed links, invitations and members, stop-sharing,
recipient accept/decline, manual link preview/join, and leaving a shared
project. Joining does not automatically bind an Agent. Newly created links
remain out of query caches and persistence, are cleared on
blur/background/account retirement, and
can be explicitly sent through the native share sheet. Removing a member and
revoking an invite link are distinct actions with distinct confirmation copy.

Agent Project bindings now expose context linking/unlinking and ordering while
keeping the primary Workspace immutable. Skill details use explicit Project
scope; owned cloud Skills support text creation/editing/deletion and GitHub import.
Edits retain the hash captured at edit start, and deletion retains the confirmed
revision. A conflict preserves the draft and requires explicit discard/reload.

### Shared Web and native domain code

`packages/shared/src/api` owns Agent Project scope/order resolution and query
keys, project sharing expiry/URL rules, Skill provenance capabilities, frontmatter
handling, revision-bound request builders and GitHub import parsing. Existing Web
consumers now import those implementations (some through compatibility re-exports);
the native screens use the same functions. Import URLs must use canonical HTTPS
GitHub URLs or owner/repository paths; ambiguous traversal is rejected before URL
normalization. Invalid share expiration dates fail closed on both platforms.
Generated schema types remain authoritative. Platform UI, authentication,
account-scoped query lifetime and navigation stay in their respective apps.

Skill packages use the shared generated download/upload client and multipart
builder (also consumed by the Web uploader). Uploads are limited to 25 MiB;
new uploads and transfers use server `create_only`, while replacement requires
explicit confirmation. Web/native share destination eligibility and transfer
ordering. A move only deletes the source after a matching upload receipt and
matching content hash, with the original hash as the delete precondition.
Uncertain uploads never trigger removal; failed removal reports a partial copy.

Native download uses Expo FileSystem and the SDK-aligned `expo-sharing` 57.0.22
from `catalog:expo57`. Rebuild the development client for this native module.
Files use random safe names under an account-hashed cache directory. Native
sharing completion does not prove delivery or that Android receivers have read
the file, so files remain until OS cache eviction or explicit account-scoped
cleanup. A stale account/focus lease cannot open the share sheet or clear files.
Incoming share extensions are not enabled by this outgoing-sharing feature.

Hosted deployment detail now links to a separate GitHub Workspace Skills surface.
It reads the server capability and resource version, renders desired-state status
and source-pinned detail, and explicitly confirms installation/removal. This uses
Hosted `/v2/deployments/{deployment_id}/workspace-skills`, not Cloud Skill package
upload or Project CRUD. Web/native share GitHub input parsing and capability
eligibility; generated Hosted schemas and the shared bounded transport remain
authoritative.

Agent detail also exposes Library Skill references and runtime plugins through
canonical Cloud APIs. Library browsing reuses paginated search and stable Skill
IDs; shared visible Cloud Skills remain eligible subject to server authorization.
Only explicit Library references can be removed here, not Project, GitHub or
bundled sources. Runtime plugins support catalog/category/search, component
metadata, explicit install/update/retry and confirmed removal. Web and native
reuse the same version ordering, compatibility and action-state model. New
plugin installs require one matching nondeleted Hosted deployment with a known
supported runtime; server policy remains authoritative.

These Cloud desired-state routes have no request-key contract: clients do not
invent idempotency headers or automatically retry mutations. Shared clients
validate response identity, requested plugin version and desired state. Native
reads are account-fenced and observation polling is bounded, foreground-only
and stops on errors. Accepted requests do not establish runtime installation;
removal may still be pending after a desired row disappears. Network failures
require an explicit refresh/retry decision, not silent replay. Real runtime and
device acceptance remains unverified.

Extension-source verification used bounded Bun 1.4.2 Docker with the unchanged
frozen root lock: six workspace TS7 checks, 260 Shared/Mobile tests (1,198
assertions), 49 related Web tests (199 assertions), and Biome on 13 source files
passed. Both platform Metro exports passed. These checks do not exercise real
accounts, device interaction or runtime convergence.

Workspace Skill mutation recovery persists account/deployment-scoped original
body, idempotency key and resource version using the existing serialized CAS
store. Replay never silently refreshes the version, which participates in the
server request fingerprint. Only a prepared request or its first proven
pre-admission rejection can be discarded; later errors cannot resolve earlier
uncertainty. Saved retries do not depend on a refreshed catalog/capability view.
Matching server receipts clear the journal, but receipt acceptance is not proof
that the runtime has applied the manifest. Requested entries use the existing
bounded foreground/online polling policy; errors, blur/background or the polling
deadline stop it. Explicit refresh restarts status checking, never a mutation.

The GitHub Workspace Skills batch passed bounded Bun 1.4.2 Docker verification:
six workspace typechecks, 256 Shared/Mobile tests (1,187 assertions), 39 focused
Web tests (159 assertions), Biome on 14 files, final independent iOS/Android
exports and post-export Mobile app/test typechecks. Manifest/lock and exact
implementation comparisons passed. A TS7 query inference issue introduced by
polling was corrected using the generated response type, without a cast or
suppression. Native storage recovery, runtime application and device navigation
remain acceptance gates, not results inferred from these exports.

The package-transfer batch passed bounded Bun 1.4.2 Docker checks: six workspace
typechecks, 253 Shared/Mobile tests (1,159 assertions), 56 focused Web tests
(206 assertions), Biome on 14 source/config files, independent iOS/Android
exports and post-export Mobile app/test typechecks. Frozen manifest/lock and
exact implementation comparisons passed. Expo dependency checking still reports
only the explicit TS7 policy difference. Native compilation, system picker/share
interaction and actual package transfers remain device acceptance work.

These additions do not establish full Web parity. Universal-link routing,
managed runtime Skill/plugin actions, remaining provider and Vault workflows,
native builds and real store payments remain separate
acceptance work. Existing Session transcripts remain read-only by design.

Session link management now includes paginated snapshot inventory, explicit
public snapshot confirmation, canonical-position excerpts and individual Agent
responses, exact-kind revocation, and native sharing of Web/Markdown/JSON links.
Owner Markdown export uses the authenticated server serializer and the native
text share sheet; it does not create a public link or persist an export file.
The native transcript requests the message-only timeline projection so share
positions remain canonical event positions, not visible-page offsets. Native
presentation is fenced against blur, backgrounding and account retirement.

Connector screens provide searchable/paginated catalog, all-status account
management, credential forms, provider-managed OAuth in the system browser,
alias updates, disconnect confirmation and tool schemas. Web and native share
authentication-flow selection, credential/default-field rules, active-account
checks and metadata batching. Secrets stay out of query/mutation caches and
are cleared on submit, blur and background. API-key presentation uses the same
foreground lease so a background/foreground cycle cannot revive a late key.

The Cloud connector contract accepts HTTP(S) allowlisted callbacks, not an app
scheme (`backend/app/schemas/connector.py`). Native deliberately omits the
callback and uses the provider-managed completion page. Expo WebBrowser 57.0.3
resolves on opening Android Custom Tabs but on closing the iOS browser; neither
result establishes authorization success. Return/focus and manual refresh query
the server's actual accounts. Native callback/deep-link integration and live
OAuth are still acceptance work; no callback allowlist is changed here.

Vault now has a paginated/searchable catalog, strict creation, stable-ID detail,
section/key-name inventory, dotenv/JSON import preview, server-side selected-key copy/move,
explicit global key/Vault deletion and Project detachment. Web and native use
the same import parser, conflict preview and slug normalizer in Shared. Stored
values are never requested; pasted values stay in component state, clear on
submit/blur/background, and do not enter query or mutation caches. Confirmations
are fenced against backgrounding, navigation and account retirement. Shared
Vaults are read-only in the UI and server authorization remains authoritative.

The dedicated `POST /v1/vault/{slug}/attachments/{project_id}` endpoint requires
`vault_id` and attaches only that owned identity. Both Web attachment surfaces
and native detail use it; a deleted identity never resolves to a replacement
with the same slug. Existing legacy create-or-attach semantics stay unchanged.
Ship the backend route before these clients: older servers fail closed at the
new route, and clients never fall back to the legacy endpoint. Missing identities,
foreign owners and out-of-bound Agent keys are rejected; exact attachment does
not rename or create Vaults. Automatic capability-link intake and device
interaction verification remain open; this is not
full Vault parity. Existing-key skipping uses the fetched key-name snapshot,
not a server-side compare-and-set guarantee against concurrent writes.

Vault owners can list the latest 100 secret requests, create a request for an
attached owned Project with explicit expiry, and share its HTTPS fragment link
using the native share sheet. Shared validation preserves exact field-name case
and enforces the server's 1–32 distinct-name limit. Pending records poll every
10 seconds for at most two minutes while the screen is foregrounded; manual
refresh restarts that window. Supplied records invalidate the key-name view.
Request capabilities never enter query keys/caches, route parameters, logs or
device storage. Only the latest link is retained in a foreground ref for share
retry, cleared on blur/background/account retirement.

Recipients can paste a request link into the public native supply screen, including
while signed out. Web's public supply page uses the same Shared capability
transport for inspection, import preflight and submission. It sends no account token and explicitly
omits cookies, caching, redirects and referrers. Native fields support dotenv import,
case-sensitive names and server preflight before explicit overwrite confirmation.
Submission is never automatically retried; unknown outcomes are not reported as
success. Native blur/background clears entered secrets and retires response permission.
Configured HTTPS links now support one-shot native intake as described below.
Device networking, input, lifecycle and share-sheet acceptance remain outstanding;
Metro exports do not prove these behaviors.

### Full-parity completion scope

Session messages and Library Skill bodies now use a native Markdown renderer
with the same GFM and line-break plugins as Web, exposed through
`@clawdi/shared/markdown`. Parser dependencies are explicit root-catalog entries,
not accidental Web hoists. Native text supports headings, emphasis, lists/tasks,
reference links, quotes, horizontally scrollable tables/code and footnote text.
Raw HTML remains literal text. Source view and progressive text expansion remain
available; oversized or overly deep syntax falls back to readable plain text.
Remote images require explicit confirmation before native preview. The shared
Session/Skill renderer offers HTTPS PNG/JPEG/WebP previews, with a 4 MiB streamed
download ceiling, a 20-second network deadline, no account/cookie credentials or
redirects, and raster signature validation. Expo fetch ignores the standard cache
option, so requests also carry `Cache-Control: no-store`; the app writes no image
files. Previews clear on blur/background or account/content replacement. A
30-second presentation deadline fences late native metadata results; native
decoding itself cannot be cancelled. Images exceeding 4096 per dimension or
8 million pixels are not displayed. Original browser links remain available for
unsupported formats. Native codec memory, rendering and accessibility acceptance
remain device gates, not established by parser/network tests or Metro exports.
Native HTTP(S) links show their full target for confirmation, reject credentials,
ambiguous control characters and app/file/data schemes, and respect captured
account/focus leases. Relative URLs have no invented base and remain text.

This batch passed six workspace TS7 checks, 263 Shared/Mobile tests (1,217
assertions), 10 related Web tests (33 assertions), frozen Bun 1.4.2 reinstall,
and final iOS/Android exports plus post-export native/test TS programs in one
bounded container. The lock change only records explicit Shared dependencies
and root catalogs for versions already resolved by Web. No native build or
visual/device acceptance is implied. Library reference detail navigation now
uses the existing `/skills/detail` route and generated source Project/key;
missing source metadata disables navigation instead of inventing a route.

Runtime UI and terminal remain separate unfinished surfaces. Read-only inspection
confirmed that the current Hermes browser-session endpoint requires the configured
Web Origin and browser cookie context. Native support needs an explicit backend
authentication handoff contract; spoofing Origin or assuming native fetch cookies
are shared with an external browser is not an implementation. No live session,
terminal connection or server configuration was changed during this audit.

Account links to the native AI Provider inventory. It reuses Shared managed-provider
filtering, generated Cloud contracts and the bounded authenticated transport.
Label-only updates preserve credentials and routing; explicit configuration
validation does not claim upstream connectivity. Queries and action completions
are account-scoped, and mutations never automatically retry. Native BYOK creation
shares Web provider metadata, region choices and duplicate-safe form identity;
custom connections expose all four supported protocols. After submission, the
request body and idempotency key are fixed for explicit retry. Keys remain in
component memory and are cleared on blur/background; an uncertain result warns
the user to inspect the inventory before starting a new connection. There is no
implicit model discovery or inference request. Web retains compatibility exports
for the extracted Shared form helpers. Connection editing also shares
`providerEditOperation`: connection/custom credentials use an atomic PATCH
without model or credential-environment fields, while native/catalog key
replacement uses accept with `replace: true` and the captured idempotency key.
Settings-only edits do not carry credentials. Native forms support routing and
region choices, preserve immutable retry input and clear entered secrets on
blur/background. ChatGPT device authorization and reconnect use the generated
Cloud start/poll contracts and the same Shared Provider body as Web. Native
polling respects server intervals, pauses on blur/background/offline, fences late
results and stops on expiry or three consecutive failures. Browser handoff keeps
the current authorization in memory; account retirement/unmount drops it.
Only the exact HTTPS device-verification page emitted by Cloud can open externally.
Metadata refresh does not remount an active OAuth row. Real-device browser return
and actual provider sign-in remain outstanding.

Native removal reviews Hosted impact and requires explicit acknowledgement before
DELETE. Web/native share strict confirmation-header validation. Retries retain
the same impact revision, provider incarnation and idempotency key; 409/503 never
imply that no Agent configuration changed. A new impact requires a separate review
and acknowledgement, without silently abandoning the prior attempt. Confirmed
removal invalidates only the current account's caches and distinguishes pending
upstream revocation from completed local removal. No direct Cloud DELETE is used.
Device interaction and real provider/Agent removal remain unverified.

Native Project detail is readable by accessible members; sharing management has
its own owner-gated route. Agent, Skill and Vault catalogs reuse their existing
list UI with explicit Project scope and account/Project/search cache keys. A
malformed, duplicate, missing or inaccessible explicit Project never falls back
to an unscoped resource request; clearing the filter is an explicit user action.
Scoped Agent lists show only the caller's linked Agents, not other members' Agents.
Skill creation preserves the selected writable Project and never picks a different
one after permission loss. Scoped Vault creation uses strict `create_only` with
`project_id`, creating and attaching in one server operation; global creation stays
unattached. Shared/archived/Agent-managed scopes do not expose creation controls.

Web and native use `transferVaultKeys` for deduplicated, section-grouped batches
of at most 150 names. Native selection supports individual keys and whole sections.
Both source and destination mutations pin Vault IDs. A partial/unconfirmed copy
never authorizes source deletion; only a full matching count permits the delete
step. Results distinguish confirmed copies from incomplete copy and skipped or
unconfirmed cleanup. This is not a transactional move or compare-and-set: concurrent
source edits can race between copy and deletion, and the UI warns against them.
Native foreground/account retirement stops subsequent batch operations; an already
sent mutation can still finish server-side. No automatic mutation retries occur.

Prefix splitting is implemented on both surfaces through Shared `prefixGroupsFor`,
`validVaultSplit` and `splitVaultKeys`. Exact prefixes stay distinct even when their
default slugs collide; editable destination slugs must be unique before any write.
Creation uses `create_only`, never implicitly reuses an existing destination, then
copies with the exact returned Vault ID and `strip_prefix`. Optional source cleanup
uses the same full-copy guard as normal moves. Reports retain partial destinations
for inspection; failed creation can have an unknown outcome, and empty/partial
Vaults are not automatically rolled back or linked to Projects. Native lifecycle
retirement prevents subsequent operations, not already admitted server writes.

Session lists share `normalizeSessionListQuery` and sort keys with Web. Native
search uses the shared Unicode-length limits and explicit Apply/Reset controls;
Agent type, automated/manual work, PR-link presence, sort direction and page size
are server-side filters. The immutable Agent route scope remains in every request.
Account generation and normalized filters isolate pagination caches; filter changes
start at page one, preserve explicit false values, and do not reuse the old result
as placeholder data. Match excerpts render as plain text.

Native Session activity reuses Shared search-anchor parsing, literal highlighting,
and timeline row/tool-pair grouping with Web. User/assistant/tool categories,
in-Session search, previous/next matches, beginning/latest windows and bidirectional
history paging use the generated typed timeline API. Only the initial window sends
an anchor/search query; adjacent pages pin its content revision and use returned
offsets (not event positions). Partial previous windows request only their missing
range. Native scroll-to-match recovery is bounded and cancelled on retirement;
real-device variable-height scroll behavior remains an acceptance gate. Tool output
is expandable plain text, never executable, and long payloads reveal incrementally.

Native deployment detail now supports confirmed start/stop/restart, dashboard-access
reset, language/timezone updates and AI provider/model binding. Web/native share
lifecycle availability and strong ETag validation; binding construction reuses the
existing Shared provider rules. Mutations pin the displayed version, original body
and idempotency key, never automatically refresh/retry writes, and reject unrelated
operation receipts. The first explicit version rejection permits review; uncertainty
remains sticky on later errors. An accepted receipt starts bounded operation polling
and yields to the matching or a higher-generation server receipt. Stopping compute does not
cancel billing. Runtime attempts use SecureStore keys derived from account and Agent
identity, sharing the creation journal's serialized compare-and-set implementation.
The original key/version/body is saved before sending; an uncertain marker is durable
before network dispatch. Reopening restores that exact request without consulting a
changed provider/model catalog. Only unsent or first-proven version-rejected attempts
can be discarded. Corrupt/unreadable storage disables new runtime changes; an explicit
reload recovers concurrent-screen conflicts. No real lifecycle or provider mutation
was used for validation; device persistence/kill-and-relaunch acceptance remains open.

An accepted operation also exposes an explicit cancellation request. Shared Web/native
eligibility excludes completed operations and image/runtime-context migrations; unknown
verbs fail closed. The native key is deterministic for the account and immutable operation
name, so explicit retries after a restart target the same cancellation. A successful empty
acknowledgement only restarts bounded status polling: it does not assert rollback, stopped
compute or cancelled billing. Failed/ambiguous requests never automatically retry.

Native Agent deletion explicitly preserves paid subscriptions and warns that billing may
continue. Included Basic capacity release remains a server lifecycle decision. The shared
client rejects cancellation choices before authentication/network;
provider-origin subscription management remains gated, not silently bundled with deletion.
The same durable journal pins DELETE body/version/key and remains accessible when the
deployment snapshot is unavailable. A GET 404 never clears an uncertain request: only its
matching DELETE acknowledgement (accepted operation or `status: absent`) resolves it.
Server-reported absence is not a claim that background infrastructure cleanup has finished.

Agent settings expose name/reset, avatar upload/reset and confirmed local-Agent
disconnect. Web/native share name-draft synchronization, avatar limits and
disconnect eligibility. The system file picker uses the existing SDK-aligned
`expo-file-system` 57.0.7 through `catalog:expo57`, without an additional image
picker dependency. Uploads accept PNG/JPEG/WebP up to 2 MiB and never auto-retry.
Disconnect refreshes ownership and Agent identity before dispatch; incomplete
ownership fails closed. Legacy ownership IDs are read only when server capabilities
require them; this does not expose legacy product actions. Unsaved names use
Expo Router's removal guard with a native discard confirmation and captured
account/focus permission. Device picker/upload, disconnect and navigation
acceptance remain pending.

The Agent settings batch passed bounded Bun 1.4.2 Docker verification: all six
workspace typechecks (including both Mobile programs), 249 Shared/Mobile tests
(1,129 assertions), 37 focused Web tests (143 assertions), Biome on 18 files,
independent iOS/Android exports and post-export Mobile typechecks. Frozen install
preserved the lock and manifests; exact implementation files matched the tested
container. These results do not establish native compilation or live mutations.

Account appearance uses the Expo native picker for light/dark/system, with a
device-local SecureStore preference. The allowed modes/validation are shared with
Web. UniWind 1.12.1 `setTheme` owns React Native Appearance integration and system
change handling; Expo control Hosts and the status bar consume the resolved theme.
Storage read failures expose an explicit retry; writes are serialized and applied
only after persistence succeeds. Stale hydration/unmount results are ignored.
Real-device cold start, OS theme changes and native control rendering remain
acceptance gates.

The deploy OpenAPI allowlist explicitly includes Hosted `DELETE /v1/me` for the
Phase 2 deletion page;
the existing generator adds its 204 response without handwritten wire types.
Verify against the coordinated contract in an isolated runner:

```bash
DEPLOY_OPENAPI_SOURCE=/path/to/reviewed/openapi.json DEPLOY_CONTRACT_FETCH_MODE=strict bash scripts/check-deploy-generated-api.sh
```

Done: the filtered generated client matches exactly; the HTTP client regression
accepts 204, rejects an unexpected 200 and does not retry 403/500 responses.

Public Session routes (`/s/[shareId]`, `/open-share`) support anonymous snapshots,
explicit pagination and native Markdown/JSON sharing. Snapshot requests omit
account tokens and cookies; missing shares return 404 and revoked shares return
410. The native view clears content on blur/background and revalidates on return.
Pagination rejects changed totals or revisions. Retired live Session links no
longer resolve.
Sign-in continuation accepts only a validated share UUID, not arbitrary redirects.
Manual HTTPS/custom-scheme input extracts the ID and uses the configured Cloud
API; it never fetches a pasted hostname.

Optional `EXPO_PUBLIC_CLAWDI_LINK_HOSTS` is a comma-separated list of owned DNS
hostnames, without schemes, ports, wildcards or paths. Build and runtime use the
same validator. Expo config adds iOS `applinks` associations and Android verified
HTTPS filters for the paths in `@clawdi/shared/linking`, preserving
existing associations. No configured hosts means no new HTTPS associations.
The shared module is synchronous ESM JavaScript, which Vite and Metro consume
directly. Expo's `app.config.js` uses Node 24's native `require(ESM)` support;
no TypeScript loader or generated CommonJS copy is needed. See
[Expo dynamic configuration](https://docs.expo.dev/workflow/configuration/),
[Node ESM interoperability](https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require),
and [Vite linked dependencies](https://vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies).
For an isolated config check:

```bash
EXPO_PUBLIC_CLAWDI_LINK_HOSTS=links.example.test bunx expo config --type public
```

Done: the generated config includes `applinks:links.example.test` and matching
Android paths. Web serves AASA and assetlinks from `/.well-known/`, with AASA
components using the same path source. Configure the Web server's public
`CLAWDI_APPLE_TEAM_ID` and `CLAWDI_ANDROID_CERT_SHA256` as described in the
[Web README](../apps/web/README.md#mobile-app-links); each endpoint returns 404
until its signing identity is valid. OS verification still requires published
association files and signed iOS/Android builds.

Each shared link root has an exact match and a slash-delimited prefix, so `/s`
does not capture `/skill.md` or `/sign-in`. AASA and Android 15+ Dynamic App Links
(on devices with Google services) exclude public agent files, including
`/skills/*/SKILL.md`, before resource matches. Older Android static filters cannot
negate `/skills/` descendants;
native intake opens verified-host agent files with `expo-web-browser.openBrowserAsync`
(Android Custom Tabs with an explicit browser package; iOS SFSafariViewController).
It never reopens these URLs with `Linking.openURL`. Warm intake preserves the
current native screen; browser launch failure goes to manual link input.

Allowed HTTPS Vault request links stay in a single-use, 60-second memory inbox;
Router receives only a random intake reference, never the capability token.
The focused supply screen requires explicit inspection and submission. Its
received secrets clear on blur/background; no automatic request is sent.
Relative/custom-scheme Vault request links lack a verified HTTPS origin and
open manual input without retaining the token. Real-device cold/warm starts,
StrictMode, backgrounding and account transitions remain acceptance checks.

The native deployment terminal uses Expo SDK 57 DOM components with
`@expo/dom-webview` 57.0.1 and SDK-compatible `react-native-web` 0.21.3. A dedicated
Shared DOM entrypoint owns the xterm 6 renderer, ttyd transport, resize, output
flow control and reconnect lifecycle, consumed by both the Web panel and native
DOM adapter. Root catalogs centralize these versions; the regular Shared API
barrel never imports xterm. Web compatibility exports remain intact.
`createTerminalClient` uses the generated POST contract, existing
bounded auth transport and no automatic retry. It rejects expired/mismatched
capabilities and WebSocket targets outside the configured compute origin/path.
Alternative public terminal origins require an explicit allowlist contract rather
than silently trusting an arbitrary response URL. Native callers must pass their
account-generation read signal and never persist/log/cache credential URLs.
The mobile route issues credentials only after explicit Connect, offers native
disconnect/reconnect and Esc/Tab/Ctrl+C controls, and destroys the DOM view on
blur/background/account change. DOM callbacks recheck foreground/account leases;
short-lived URLs never enter persistent/query storage. Native-module bridging is
disabled; external links and OSC hyperlinks are disabled in the native terminal.
Each connection attempt has a 20-second deadline covering credential acquisition
and WebSocket opening, including subprotocol-to-query fallback. Timeout retires
late callbacks and closes the socket; explicit retry remains available. Disposal
clears the deadline and prevents retained handles from starting another attempt.
An isolated Chromium clock/network probe verified stalled credentials, stalled
handshake, zero sockets from late credentials and no retry after disposal.
Both platforms exported native and DOM bundles with a single React 19.2.3
identity in each source map. An isolated Chromium/local-WebSocket probe exercised
real xterm input, resize, two handshakes with fresh credentials after 1013, and
socket cleanup. This is not an iOS/Android WebView, keyboard, real server or native
compile acceptance test; those gates remain open. DOM view background teardown
does not stop compute or guarantee remote command termination.
Deployment detail now offers an explicitly confirmed system-browser dashboard
entry. It refreshes the deployment and refuses a changed published endpoint.
OpenClaw credential issuance uses generated POST, `If-Match`, and the same exact
endpoint/resource-version validator as Web. The capability remains local to the
action, never Router parameters, query cache or persistent app storage. Issuance
is not automatically retried; browser storage/access may survive app sign-out.
Use runtime access reset to revoke access when needed.

Hermes opens its own OIDC login route so the browser creates PKCE/state cookies;
the existing server redirects a missing browser grant through Web's protected
runtime-handoff page. A separate browser sign-in may be required. Native never
spoofs Web Origin or attempts to prime browser cookies with native fetch. Shared
navigation helpers now supply both Web and native, with Web compatibility
re-exports. Browser dismissal is not authentication or runtime-session proof.

Verify Shared/Mobile tests and Web's `runtimes.test.ts`,
`runtime-ui-credentials.test.ts`, and `hermes-oidc-browser-session.test.ts` in the
isolated runner. Done: credential issuance binds authorization, ETag and exact
endpoint, rejects stale/foreign responses, and never retries implicitly.
Real-device cold/warm browser auth, account switching and revocation remain gates.

### Native project generation

The dynamic Expo config commits `ai.clawdi.app` for both platforms. Native
projects are generated and ignored; do not maintain a second native source tree.
From `apps/mobile`, run `npx expo prebuild --no-install`. `EAS_PROJECT_ID` is
optional for local prebuild; when unset, no update URL/project id is emitted.
Done: generated identifiers match `ai.clawdi.app`, iOS contains
`PrivacyInfo.xcprivacy`, and Android has `allowBackup="false"`. This checks
plugins and metadata, not native compilation, signing or store acceptance.

### Release configuration

`apps/mobile/eas.json` selects the matching EAS environment and update channel
for development (dev client), preview (internal APK) and production (store).
Production uses remote build numbers with auto-increment; all binaries use
fingerprint runtime compatibility.
Each build profile pins Node 24.21.0 (the repository's Node 24 major) and Bun 1.4.2
so Expo's synchronous `require(ESM)` uses the same toolchain locally and on EAS.
See [EAS build tool versions](https://docs.expo.dev/build/eas-json/#selecting-build-tool-versions).

Fixture verification uses `e2e` for Android and `e2e-ios` for the iOS Simulator.
`e2e-ios` extends `e2e` with the documented
[`ios.simulator: true`](https://docs.expo.dev/build-reference/simulators/);
device/release profiles stay separate. See the
[EAS smoke commands](../apps/mobile/.maestro/README.md#manual-ios-simulator-smoke-in-eas)
for build reuse, test artifacts and pending cloud verification.

Keep all `EXPO_PUBLIC_*` values in the selected EAS environment, with plaintext
or sensitive visibility, never in build-profile `env`. [Expo Update uses that
environment, not profile variables](https://docs.expo.dev/eas/environment-variables/usage/#using-environment-variables-with-eas-update).
Configure these exact release values in **each** environment:

| Variable | `preview` | `production` |
| --- | --- | --- |
| `EXPO_PUBLIC_CLAWDI_ENV` | `preview` | `production` |
| `EXPO_PUBLIC_CLAWDI_API_URL` | `https://cloud-api.clawdi.ai` | `https://cloud-api.clawdi.ai` |
| `EXPO_PUBLIC_CLAWDI_COMPUTE_API_URL` | `https://api.clawdi.ai` | `https://api.clawdi.ai` |
| `EXPO_PUBLIC_CLAWDI_LINK_HOSTS` | `cloud.clawdi.ai` | `cloud.clawdi.ai` |
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | Owner's Clerk publishable key | Owner's `pk_live_` key |
| `EXPO_PUBLIC_REVENUECAT_APPLE_KEY` | Owner's public SDK key, or unset pending IAP setup | Owner's public SDK key, or unset pending IAP setup |
| `EXPO_PUBLIC_REVENUECAT_GOOGLE_KEY` | Owner's public SDK key, or unset pending IAP setup | Owner's public SDK key, or unset pending IAP setup |
| `EXPO_PUBLIC_SENTRY_DSN` | Owner's DSN, or unset | Owner's DSN, or unset |

For `development`, set `EXPO_PUBLIC_CLAWDI_ENV=development`, a device-reachable
development Cloud URL and a Clerk test key; compute, link hosts,
RevenueCat keys and DSN are optional, using the development values described
above. Never set `EXPO_PUBLIC_DEV_AUTH_*` in preview or production. Public values,
including publishable keys and DSNs, are readable in the binary.

In each environment, set `EAS_PROJECT_ID` to the owner's Expo project UUID with
plaintext or sensitive visibility so both Build and Update can resolve it.
When unset, local config/prebuild omits the project id and update URL.
Keep Sentry upload settings env-only: `SENTRY_ORG`, `SENTRY_PROJECT` and secret
`SENTRY_AUTH_TOKEN`. For CI updates, configure the matching `SENTRY_ORG` and
`SENTRY_PROJECT` GitHub variables and `SENTRY_AUTH_TOKEN` secret in the production
GitHub Environment; EAS secret values are unavailable during Update.

`EXPO_PUBLIC_CLAWDI_ENV` is the sole environment source for validation and
Sentry, including when updates are disabled and their channel is empty.
Non-development builds require `EXPO_PUBLIC_CLAWDI_ENV=preview` or `production`,
HTTPS Cloud/compute APIs and real Clerk auth;
`production` additionally requires a `pk_live_` key. Invalid values show
`ConfigurationErrorScreen`. CI exports both platforms with bypass requested and
rejects complete fixture identity/token literals; Clerk itself also ships
`/dev_browser` and `dev_browser_unauthenticated`.

Owner's first-build checklist:

1. **Before any CI release, enable the required repository settings.** In
   **Settings → Environments → production**, choose **Selected branches and tags**:
   allow only the branch `main` and tags matching `mobile-v*`. Enable **Required
   reviewers** for the release owners and keep release tokens in this Environment.
   In **Settings → Rules → Rulesets**, enable an **Active** tag ruleset targeting
   `mobile-v*` with **Restrict creations**; limit its bypass actors to authorized
   release maintainers. The workflow's ref check is only a fast-fail; these
   [Environment protections](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
   and [tag creation restrictions](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#restrict-creations)
   enforce who can release and create release tags.
2. **Without Sentry credentials, set `SENTRY_DISABLE_AUTO_UPLOAD=true` in the
   selected EAS environment before the first build.** The plugin always installs
   native upload hooks; omitting the DSN disables reporting, not those hooks.
3. Configure the public values above and `EAS_PROJECT_ID` in that same environment.
4. Supply Expo/signing credentials, then run from `apps/mobile`:

```bash
eas build --profile preview --platform android
```

Done: the resulting APK is non-debuggable, has no release cleartext override,
no backup and no blocked permissions. This remains an owner-run acceptance gate.
The owner must supply the non-secret App Store Connect app ID for
`apps/mobile/eas.json` at `submit.production.ios.ascAppId`, then commit its numeric
string before iOS auto-submit. [EAS Submit requires that field for CI](https://docs.expo.dev/submit/eas-json/#production-profile);
EAS CLI 24.8.0 does not interpolate environment references in `ascAppId`.
Configure signing credentials and Play's service account through EAS credentials.

Dispatch [Mobile release](../.github/workflows/mobile-release.yml) only from
`main` or a `mobile-v*` tag. Both `operation=build` and `operation=update` use the
production GitHub Environment and require its `EXPO_TOKEN` secret plus the
`EAS_PROJECT_ID` GitHub variable. Preflight also uses that Environment to check
release configuration and Sentry token presence: **preflight and the selected
build/update job each request production approval**. Preflight rejects other
refs, missing release configuration, iOS/all auto-submit without `ascAppId`, and
updates with a Sentry token but missing `SENTRY_ORG`/`SENTRY_PROJECT`, before EAS runs.
Biome, mobile typecheck, tests, separate iOS/Android exports and a production
export that requests dev auth bypass and rejects fixture markers must pass before
either operation. `build` uses the production profile, the selected `platform` and
optional `auto_submit`; `update` requires a `message` and a `channel` of `preview`
or `production`, passed as both `--channel` and `--environment` to EAS CLI 24.8.0.
Done: preflight and `verify-mobile` are green before the selected release job runs.

Sentry is inactive without a DSN. When enabled, it reports root exceptions and
samples performance at 0.1 using Sentry RN's native release/dist defaults. It
drops Vault-request telemetry and strips identities, request bodies, URL queries
and token parameters; session replay is disabled. The Expo Sentry plugin always
installs native upload hooks, with env-only credentials. This keeps the plugin
set stable between Build and Update. SDK57 fingerprinting includes resolved
`extra` and loaded plugins: use the same public values and `EAS_PROJECT_ID` for
both, and do not put build-only credentials in config. Changing these public
config values can require a new binary.

After a successful CI Update, the workflow runs the documented
[`npx sentry-expo-upload-sourcemaps dist`](https://docs.expo.dev/guides/using-sentry/#usage-with-eas-update)
only when `SENTRY_AUTH_TOKEN` is configured, using the same Sentry org/project.
The token is scoped to that upload step; preflight receives only its presence
flag. Without the token, source map upload is skipped with a GitHub warning.
Store review precedes OTA; reserve OTA for compatible JavaScript fixes.

Done: a preview crash is symbolicated in Sentry, and a build without a DSN runs
normally. These live checks, TestFlight privacy validation and store metadata
inputs remain outstanding; see [mobile store compliance](mobile-store-compliance.md).

The October 3 probe generated both Android and iOS projects in one disposable
Bun 1.4.2 container with `test.example.clawdi.probe` and `links.example.test`.
Android's application ID/namespace and iOS Debug/Release bundle identifiers
matched the injected value; associated-domain/intent-filter metadata was present.
The first Android generation warned that `expo-system-ui` was missing. After
adding SDK57/registry-latest `57.0.4`, generation completed without that warning
and Android resources contained `expo_system_ui_user_interface_style=automatic`.
Expo's template comparison still reports `catalog:expo57` rather than a numeric
manifest version; this does not change the frozen resolved Expo/RN versions.
Neither Gradle, CocoaPods nor Xcode compilation ran in this probe.

### Android compiler follow-up

The follow-up uses real Node 24.21.0, Bun 1.4.2, Temurin JDK 25.0.4.1,
the generated Gradle 9.3.1 wrapper, SDK 36, NDK 27.1.12297006 and CMake 3.22.1.
Toolchain downloads are confined to the disposable container; no host JDK/SDK
installation or signing configuration is required. Node/JDK downloads were
checked against publisher SHA-256 metadata and Android Command-line Tools 23
against Google's repository checksum. The current Android CLI uses `android sdk`
in place of the deprecated `sdkmanager` compatibility entry point.

The first compiler run reached 231 tasks but failed in Worklets' Prefab/CMake
configuration, not C++ compilation. AGP 8.12.0's `GeneratePrefabPackages`
parser treated JDK 25's JNA native-access warning as an error. Supplying
`JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED` to the build command and
its child JVMs made that exact CMake task pass. This is the JDK's explicit
native-access opt-in; do not filter stderr, patch vendor binaries or disable
compiler checks. AGP recognizes the `JAVA_TOOL_OPTIONS` startup message as
informational. SDK XML-version and third-party deprecation warnings remain.

The unsigned ARM64 Debug compiler gate runs these tasks (not `assemble` or
`bundle`, so it does not produce or sign an installable artifact):

```sh
JAVA_TOOL_OPTIONS=--enable-native-access=ALL-UNNAMED \
  ./gradlew :app:compileDebugKotlin :app:compileDebugJavaWithJavac \
  :app:externalNativeBuildDebug --no-daemon --max-workers=2 \
  --init-script ../scripts/android-compile.init.gradle \
  -Dorg.gradle.parallel=false \
  '-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m' \
  -Pkotlin.compiler.execution.strategy=in-process \
  -PreactNativeArchitectures=arm64-v8a
```

Run from the isolated generated Android directory with `JAVA_HOME`, SDK paths
and a task-local `GRADLE_USER_HOME` configured; bound the command with a timeout.
This does not validate Release/R8, other ABIs, iOS compilation, installation,
device UI/authentication or purchases.

The opt-in [Gradle init script](../apps/mobile/scripts/android-compile.init.gradle)
assigns CMake/Ninja pools of two compiler jobs and one linker job per native
build. These are not global limits: two Gradle workers can run separate native
builds concurrently. The script applies to both Android application and library
plugins through `defaultConfig.externalNativeBuild.cmake.arguments`.

Done: the bounded command exits 0 with `BUILD SUCCESSFUL`; generated application
and library Ninja rules assign every C++ compile/shared-link edge to these pools.

Verified October 3, 2026 (PDT) in the bounded 2-CPU/8-GiB container: the full
compiler gate exited 0 in 11m 50s (282 tasks: 235 executed, 47 up-to-date).
Application Kotlin/Java classes and ARM64 `libappmodules.so` were present.
Generated Ninja rules assigned all 69 application compiler edges / four shared
link edges and 38 Worklets compiler edges / one shared link edge to the pools.
The initial init-script candidate used the wrong top-level CMake DSL and failed
configuration; the corrected `defaultConfig` form passed both library and
application configuration before the full compiler run. Cgroup memory-limit
events remained nonzero, but `oom` and `oom_kill` were zero. The verified script,
root/mobile manifests and lock matched source. No JavaScript suite rerun is
implied by this compiler-only follow-up. The disposable container, toolchains,
caches and native outputs were removed after verification.

> HISTORICAL - The preceding run lacked Ninja pools; use the init script above.

The preceding full invocation did **not pass**: its 900-second limit expired
with exit 124 during `:app:buildCMakeDebug[arm64-v8a]`. Application Kotlin/Java
tasks and Worklets/Reanimated native-library tasks had progressed successfully,
but the final application native build was unfinished. The 2-CPU/8-GiB container
hit sustained memory pressure; observed cgroup counters had `oom_kill=0`.
`--max-workers=2` does not constrain AGP's direct Ninja invocation, which had
no `-j` argument and spawned many concurrent Clang processes. Do not repeat
this gate on a constrained runner without verifying the generated Ninja pools.
Do not treat this timeout as a
source compiler failure, a passing native build, or permission to suppress errors.
The dedicated container and its remaining compiler children were stopped and
removed after the attempt; no native artifacts or SDK caches were kept on the host.

Source implementation is not native acceptance. Keep the complete v2 Web scope
until each surface has implementation, focused verification and device evidence:

| Surface | Implemented source | Remaining scope |
| --- | --- | --- |
| Account/settings | Grouped settings menu, Clerk native AuthView/UserProfileView, API keys, AI Usage and persisted appearance; conditional custom account-deletion page | End-to-end account termination and real Clerk/device acceptance |
| Agents/Projects | Inventories, context bindings, Project CRUD/sharing, scoped resource navigation, runtime start/stop/restart/access reset with durable request recovery, operation cancellation, deletion preserving subscription, language/timezone and provider/model settings, Agent name/avatar with unsaved-name protection and ownership-protected local disconnect | Provider-aware delete-and-cancel flow and device persistence/navigation/permission acceptance |
| Sessions | Search/filter/sort inventory, match excerpts, revision-pinned typed timeline, search navigation, paired tool details, snapshot sharing, anonymous public viewing and Markdown/JSON export, native Markdown with confirmed links and bounded opt-in raster preview | OS universal-link association, device scrolling/sharing/image decoding and visual acceptance |
| Skills/Memory | Skill text CRUD/import, package upload/replace/download/share and cross-Project copy/move; Hosted GitHub Workspace Skills with durable exact-request recovery; Library references; runtime plugin catalog/install/update/retry/removal with shared Web/native policy; Memory CRUD/search and details with recall metadata/source Session navigation | Remaining Skill detail parity and native file/share/managed-runtime acceptance |
| Connectors | Catalog/search, credential/OAuth entry, all-status accounts, alias/disconnect, tools with shared Web/native identifier/name/description search | Device/provider OAuth verification and keyboard/list accessibility acceptance |
| Vault | Project filters, search/pagination, scoped create, stable-ID detail/attach, import, selected-key copy/move, prefix splitting, global delete/detach, owner secret-request inventory/create/share, public request supply with shared Web/native transport and configured HTTPS intake | Signed domain association and device acceptance |
| v2 AI providers/channels | BYOK creation/editing/rotation, device OAuth, impact-confirmed removal and Agent model binding; Custom/shared channel inventory, Telegram/Discord creation, Agent link/unlink, chat pair/unpair, command sync, health/activity, Custom deletion and WhatsApp device onboarding/repair | Native/live provider and channel acceptance |
| Deployment/billing | Included Basic and existing funded Basic/Performance eligibility/creation/recovery, paginated reusable inventory and billing/deployment views, RevenueCat credit purchases and pending-purchase recovery | New paid compute subscription creation, Customer Center management and store sandbox acceptance |
| Runtime UI/terminal | Shared Web/native xterm engine, Expo DOM terminal route, native controls and foreground teardown; bounded generated credential clients; confirmed system-browser runtime handoff, hosted one-time Files handoff and Hermes OIDC entry with shared URL validation | Native WebView/keyboard/real-server round-trip and compilation; device browser authentication and revocation acceptance |
| Platform acceptance | Typechecks, isolated suites, Metro exports and Android ARM64 Debug Kotlin/Java/C++ compiler gate | iOS/Release/other-ABI compilation, signing, real devices, accessibility/visual interaction, store sandbox purchases |

Connector tool search is a Shared literal substring filter consumed by both Web
and native; punctuation is not treated as regex or query syntax. Native keeps the
virtualized tool list and distinguishes an empty catalog from no search matches.
The current Web connector detail has no separate MCP setup surface: MCP component
presentation belongs to the v2 runtime plugin detail, not a second connector flow.

Skill detail also presents generated version, file count, Project and source
repository metadata. Text/create/import drafts have native navigation protection:
leaving requires confirmation, pending writes block removal, and acknowledged
creation can return without a false discard prompt. Edit dirtiness uses the
captured draft baseline, not a background-refreshed revision. Discard callbacks
are account/foreground fenced; uncertain writes retain the draft. Gesture/back
confirmation and background completion still require real-device acceptance.

Library Skill links without a Project now use the existing read-only compatibility
resolver through Shared. The returned Skill key must match; explicit Project reads
never fall back to another Project. Editing, deletion and archive management still
require an explicit Project route, even when the compatibility response names a
Project. Open that Project's Skills list to manage its exact copy.

Subscription details reuse Web's Shared recovery presentation for payment state,
pending commands, blocked recovery and retry schedules. Native also shows scheduled
cancellation and the server's pending plan. Copy uses native i18n; no invoice link,
purchase, top-up or subscription mutation is enabled by this read-only surface.

The source reference is `apps/web/src/pages/dashboard`, its settings components,
and `apps/web/src/hosted/v2`; exclude Hosted v1 product surfaces, not v2 features
whose implementation happens to live under a legacy directory name.

`/memories/[memoryId]` reuses the list's content/tag presentation and the existing
generated Memory response. Shared `getMemory` uses the authenticated bounded
transport, escapes the path identifier and rejects a mismatched response ID.
Details show recall count, creation time and source machine, with navigation to
the existing source Session route. Account-level recall scope is explicit: this
is not Project sharing. Deletion requires native confirmation, fences late
callbacks and invalidates only the captured account's detail/list queries.
Both list and detail deletion require the generated `status: deleted` receipt;
an empty or malformed acknowledgement is not success or an automatic retry.
Unknown deletion outcomes are errors, not assumed success; 404 reads have a
separate unavailable state. The existing HTTP regression covers owned reads,
foreign-account 404, escaped identifiers and response-ID mismatch. Real-device
deep links, long content, confirmation and source navigation remain acceptance gates.

Channel admission rules, Discord credential checks and provider-specific pairing
URL validation live in Shared and are re-exported by Web. Native mutations use
generated Cloud routes with no automatic retries. Runtime Agent tokens and newly
created webhook secrets are excluded from the client projection. Pairing codes
and form credentials remain in component memory and are cleared on blur/background;
account generations fence late results. Creation sends `agent_id: null` explicitly,
leaving linking and pairing as separate actions. An uncertain creation requires
inventory review before another submission; refreshing does not prove that an
earlier request had no effect. Provider replacement requires explicit acknowledgement.
Unpairing preserves incomplete notification/cleanup outcomes rather than reporting
unqualified success. Empty 204 deletion/unlink responses are accepted without
weakening response validation for other routes. Inactive owned bots remain visible
through the owner inventory rather than disappearing with the available bot pool.

Verify the shared channel behavior and existing Web contracts in the isolated
runner: Shared/Mobile suites plus Web's `channel-linking.logic.test.ts`,
`channel-detail-page.logic.test.ts`, `connect-bot-dialog.logic.test.ts` and
`agent-channel-cards.logic.test.ts`. Done: all behavior tests and the three
workspace typechecks pass. Native browser handoff, expiry/background behavior,
destructive confirmations and live channel operations still require authorized
device acceptance.

The channel batch passed Bun 1.4.2 frozen installation, Shared/Mobile/Web TS7,
231 Shared/Mobile tests (990 assertions), 33 focused Web tests (119 assertions),
Biome on 19 source files, separate iOS/Android Metro-Hermes exports and the
post-export Mobile typecheck. Exact source and root manifest/lock comparisons
passed. These are isolated source/bundling checks, not native compilation or
real channel acceptance.

WhatsApp linked-device onboarding and owner-confirmed repair use generated Cloud
contracts. Start retries keep the original UUID and name; repair keeps the durable
Custom bot identity. Polling is read-only from the client's perspective, pauses on
blur/background/offline, and stops after three consecutive failures or the server
deadline. Check/retry/cancel are explicit actions. Returning from another app can
resume a known session even when new-allocation readiness or inventory reads fail.
QR payloads, pairing codes and phone input are never persisted or query-cached;
backgrounding retains only redacted in-memory recovery metadata. Leaving the screen
does not promise cancellation: unfinished server sessions expire, and users can
explicitly cancel before leaving. No automatic repair or replacement runs on mount.

Shared `pairingQr` uses catalog-pinned `uqr` (0.1.3) to generate local-only paths
with a four-module quiet zone. Web renders the same geometry as native SVG; neither
uploads pairing material to a QR service nor inserts server-supplied SVG. Invalid
or oversized values fail closed. The phone-number fallback is only offered when
the server supports it; QR-only repair remains supported. Real QR scanning, device
switching, session expiry, cleanup and WhatsApp repair require authorized acceptance.

This batch passed Bun 1.4.2 frozen reinstall, Shared/Mobile/Web TS7, 234
Shared/Mobile tests (1009 assertions), all 73 Web channel tests (247 assertions),
and both platform exports plus post-export Mobile TS7. An independent jsQR decoder
recovered four distinct synthetic payloads from the actual shared path geometry;
empty/oversized inputs were rejected. Eight existing Chromium cases passed. The new
WhatsApp recovery/QR case passed a focused rerun after its assertion was corrected
to allow only the intentionally injected 503 network diagnostic. Source formatting
and exact source/manifest/lock comparisons passed. No live pairing was performed.

On an authorized simulator/device build, verify:

1. Sign in, register/verify email, recover a password and complete enabled
   second factors. Unsupported factors/session tasks must show safe guidance.
2. Switch accounts during a pending read and sign out during a pending action;
   no previous account's data or navigation may leak into the new account.
3. Browse Agent/Session lists and transcript pages, including empty, offline,
   unavailable-content and revision-conflict states; test foreground recovery.
4. Check native tabs, deep links/back navigation, safe areas, dark/light modes,
   large text and screen-reader labels on both platforms.
5. With current server eligibility, confirm Basic and Performance creation against
   existing matching entitlements, inspect operations/deployments and navigate to
   their Cloud Agents. Test reusable inventory beyond the first page and denial
   after a concurrent client claims the last entitlement. No purchase is implied.
   Lose connectivity or terminate the app after admission; recover the same
   stored request without a fresh key or an automatic replay.
   Verify explicit discard after proven first-send admission refusal and same-body
   replay after a saved managed model disappears from the current catalog.
6. Inspect Wallet balance, paginated transactions and subscription details.
   Missing compute configuration, invalid deep links and restricted accounts
   must show safe states. Native payment/management actions stay unavailable.
7. In authorized test accounts, invite an existing account, accept/decline,
   leave, revoke a link, remove a member and stop all sharing. Confirm membership
   changes refresh account-owned caches and no Agent is bound implicitly.
   Background or navigate away during link creation: a late response must not
   redisplay the URL. Verify native sharing and destructive confirmation behavior.
   Paste a link, preview its owner/project and explicitly join. The pasted host
   must never become a fetch destination: requests use the configured Cloud API.
   Cancel/blur/background pending previews and verify they do not restore a token.
8. Link, reorder and unlink context Projects without changing the primary
   Workspace. Create/import a cloud Skill, edit it concurrently on Web, and
   confirm native save reports conflict without losing the draft. Delete after
   a concurrent revision change and confirm it cannot remove the replacement.
   Verify Agent-synced/shared Skills remain read-only and account switching
   retires every pending Skill action.
   Upload a tar.gz package using the system picker; duplicate new keys must not
   overwrite existing Skills. Confirm replacement separately. Download/share on
   both OSes and confirm receiving apps can read the file before explicitly
   clearing the account's export cache. Copy/move between owned workspace
   Projects; fail destination upload and change source revision during transfer.
   Neither case may delete unconfirmed source content. A partial move must retain
   the destination and report that source removal was not confirmed.
   For a test hosted Agent, install/uninstall a GitHub Workspace Skill and check
   desired versus observed runtime state. Kill/relaunch after uncertain delivery:
   the saved key/body/version must remain unchanged. A later rejection must not
   unlock an earlier uncertain request; stale screens must not clear a newer
   journal. Verify capability loss, source changes and background/offline polling.
9. Create full/excerpt/response Session snapshots after explicit confirmation;
   use event-backed transcripts with gaps between canonical positions. Check
   snapshot revocation, export links,
   and owner Markdown text sharing. Blur/background during a create/export and
   confirm a late result never opens a native share sheet. These operations must
   be exercised only with explicitly authorized test content/accounts.
10. With authorized test connectors, exercise credentials and OAuth separately
    on iOS and Android. Cancel the browser, return from background, and refresh;
    only the server's account status establishes tool access. Verify disabled
    accounts remain manageable, required hidden defaults are sent, aliases can
    be cleared, and disconnect requires confirmation. Navigate away/background
    while creating an API key and confirm a late result never redisplays it.

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
