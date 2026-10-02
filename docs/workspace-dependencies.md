# Workspace Dependency Policy

This is the Wave 1 dependency handoff for the Clawdi repository. It is a
policy and audit record, not an approval to add the mobile app or to upgrade
unrelated clients.

## Decision Summary

- Keep the Clawdi default catalog on the existing Web/Electron/CLI toolchain.
  Web and Electron remain on React `19.2.8`; Hosted remains a separate Bun
  `1.4.2` / TypeScript `5.x` repository.
- Wave 1 mobile is Cloud-only. Hosted v1 is a legacy surface outside the
  mobile app's config and acceptance scope; retaining Shared's Hosted client
  export is a compatibility requirement for other workspaces only.
- The Wave 1 verification target is Bun `1.4.2`. The fetched Clawdi
  `origin/main` is still pinned to Bun `1.4.0`; that is a baseline fact, not
  evidence that the candidate is ready for the latest-Bun gate. The candidate
  manifest, generated lock, and verification runner must agree on `1.4.2`
  before this policy can be marked complete.
- The root candidate's object form is valid for Bun `1.4.2`:
  `workspaces.packages`, `workspaces.catalog`, and
  `workspaces.catalogs.expo57` are supported. `catalog:` means the default
  catalog; `catalog:expo57` means the named catalog.
- Use `catalog:expo57` explicitly for the SDK 57 native tuple. Never use the
  default `catalog:` for native React packages. An unused catalog is not proof
  that a mobile package resolves to it.
- Root owns the root manifests and `bun.lock`. This worktree does not change
  those files. The current lock is not evidence for the candidate: it has only
  the old top-level catalog and no `expo57` entries.

## Verified Inputs

| Input | Evidence | Result |
| --- | --- | --- |
| Clawdi `origin/main` | `6705dd9a33ecf5432b3b26cd7b7255e0e17fc31c` (fetched 2026-10-02) | Actual baseline; no mobile workspace/catalog; `packageManager` is `bun@1.4.0` |
| Candidate source | `c92bad4698c3fbed13005057c235b4f46308acd0` plus the Wave 1 mobile/catalog working-tree delta | Descends from `origin/main`; shared API and WhatsApp packaging repair present. The uncommitted candidate delta is not itself a reviewed commit. |
| Hosted source | `a0349c6eee669cf237c7c297ccfe0f6527a54791` | Inherited read-only comparison only; no Hosted files changed or revalidated in this leaf |
| Clawdi baseline toolchain | `origin/main:package.json`, `origin/main:bun.lock` | Bun `1.4.0` package manager; lock `configVersion: 1` |
| Wave 1 verification toolchain | Root-approved isolated runner | Must print Bun `1.4.2`; no host install or a Bun `1.4.0` lock check substitutes for this gate |
| Candidate catalog shape | Root candidate `package.json` | Static catalog-reference closure passed; all current references resolve to the default or explicit `expo57` catalog |
| Candidate Expo config | `apps/mobile/app.config.js` | CommonJS dynamic config; a Node smoke with test values preserved config/plugins and omitted blank values. Expo CLI must still execute it to produce the effective config and public `extra.clawdi` values. |
| Shared runtime imports | `packages/shared/src/api/read-clients.ts:1`, `packages/shared/src/x402/payment.ts:1-11` | Direct runtime/type dependencies are declared by Shared |
| WhatsApp filtered consumer | `packages/cli/tests/fixtures/managed-whatsapp-native-e2e/Dockerfile:42-50,140-150` | The CLI-filtered image copies `packages/shared/node_modules`; preserve this c92 repair |

The static closure check covered every current `catalog:` reference in the
candidate's root, Web, Desktop, CLI, Shared, and sidecar manifests. It found
no missing default or named entry. No install, test, native build, or lock
regeneration was run in this leaf worktree.

## Bun 1.4.2 Contract

The official Bun `bun-v1.4.2` sources establish the following contracts:

- [`docs/pm/catalogs.mdx`](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/pm/catalogs.mdx)
  accepts `catalog` and `catalogs` either inside an object-form `workspaces`
  field or at the package root. Catalog references are valid in
  `dependencies`, `devDependencies`, `optionalDependencies`, and
  `peerDependencies`.
- The same document defines `catalog:` as the default group,
  `catalog:<name>` as a named group, and `catalog:default` as the default
  group. A catalog reference behaves as the catalog's declared range; it does
  not by itself prove the lock resolution or physical module identity.
- [`test/cli/install/catalogs.test.ts`](https://github.com/oven-sh/bun/blob/bun-v1.4.2/test/cli/install/catalogs.test.ts)
  exercises both top-level and `workspaces`-nested catalogs and named groups.
- [`src/install_types/NodeLinker.rs`](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/install_types/NodeLinker.rs)
  documents `Auto` as isolated for workspaces and hoisted without workspaces.
  The lock's `configVersion` and the actual install command still need to be
  recorded; do not infer the linker from a string in `package.json`.
- [`docs/pm/workspaces.mdx`](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/pm/workspaces.mdx)
  documents workspace linking and filtered installs. A filtered install may
  omit physical workspace dependency directories that a runtime image later
  needs to copy.

The candidate's `workspaces` object is therefore a valid Bun 1.4.2 shape. The
required root gate is:

```bash
bun --version
bun install --frozen-lockfile --offline --ignore-scripts --dry-run
```

Run this only in the existing pinned, bounded, no-network, read-only,
unprivileged container approved by root. `bun --version` must print `1.4.2`.
The frozen dry run must exit zero and leave `package.json`, every workspace
manifest, and `bun.lock` byte-for-byte unchanged. The generated lock must be
reviewed for its workspace specs, catalog metadata, exact resolutions, and
peer contexts before any product branch consumes it.

## Wave 3 Compatibility/CI Audit

A read-only comparison of the latest agent-billing Wave 3 candidate
(`9b5c07c36873ab6c98e1a1926c351a7fe172da75`) found two gates that must not be
silently treated as passed:

- `apps/mobile/compatibility/Dockerfile` still starts from the pinned Bun
  `1.4.0` image, while the candidate root manifest requires Bun `1.4.2`.
  Its generated probe lock and install evidence therefore do not prove the
  latest-Bun contract. Replace it with a reviewed Bun `1.4.2` image digest,
  regenerate the probe lock with that image, and require `bun --version` to
  print `1.4.2`; do not use a mutable `latest` tag or copy a host lock.
- `.github/workflows/client-ci.yml` runs mobile typecheck/build and iOS/Android
  JS exports, but it does not invoke `apps/mobile/compatibility/run.sh`. Bundle
  export alone does not enforce Expo's dependency check, peer closure,
  polyfills, or the single-React identity audit. A bounded compatibility job
  (or an equivalent step in the routed mobile job) must run the supported
  diagnostic and fail on any status other than the explicitly approved
  TypeScript `7.0.2` versus Expo 57 TypeScript `~6.0.3` warning.

The checked-in Wave 3 evidence makes the gap concrete: the intentionally
drifting `latest` profile resolves React `19.3.0`, React Native `0.87.1`, and
related peers instead of the Expo57 tuple, while `supported-diagnostic` has
frozen install and both Metro exports passing but still records the expected
TypeScript-only Expo warning and a fixture `className` typecheck failure.
Neither profile is product-approved
until the probe image, lock, and CI gate are corrected and rerun. The
`supported-diagnostic` profile is diagnostic evidence only; it must never
rewrite the real mobile manifest or root lock.

## Expo 57 and `app.config.js`

The candidate uses `apps/mobile/app.config.js`, not a static `app.json` or a
TypeScript config. It exports a CommonJS function that receives Expo's
`{ config }`, preserves that config, and adds the `expo-router` and
`expo-secure-store` plugins, `newArchEnabled: true`, `experiments.typedRoutes`,
and public `extra.clawdi` values. Its `publicValue()` helper trims
`EXPO_PUBLIC_CLAWDI_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`,
returning `undefined` for blank values. Mobile v2 is Cloud-only: it does not
configure a Hosted URL or opt into the legacy Hosted v1 surface. The config
does not select the React version or prove the catalog/lock resolution.

The Expo checks must execute this dynamic config in the installed Expo 57
environment; parsing `package.json` alone is insufficient:

```bash
cd apps/mobile
bunx expo config --type public --json
bunx expo install --check
bunx expo-doctor
```

`expo config` is expected to load the CommonJS module without a TypeScript
loader and to show the intended name/slug/scheme, iOS and Android platforms,
both plugins, `newArchEnabled`, typed routes, and at most the two public
`extra.clawdi` keys (blank values are omitted). Run with test values (never
credentials) and record the JSON plus exit status. `expo install --check` and
`expo-doctor` are read-only checks; do not run `--fix`, and do not accept a
silent rewrite of a manifest or lock. Expo's SDK 57 recommendation
may report the root catalog's TypeScript `7.0.2` against the SDK 57 template's
TypeScript 5.x expectation. That is the only accepted Expo-check mismatch;
React `19.2.3` and native-peer versions must satisfy the named catalog. A
TypeScript warning is accepted only when its exact CLI output is recorded and
the root TypeScript policy owner signs off; never run `--fix` to downgrade the
default catalog. An Expo check that reports a React `19.2.3` or native-peer
exception when compared with a default-catalog React `19.2.8` is a failure
unless the
`catalog:expo57` manifest references, frozen lock peer context, and physical
module identity all prove the named tuple below. A check that upgrades the
default catalog, adds an override, or changes the lock is a failure, not a
resolution of the exception.

## Catalog Rules

### Default catalog

The candidate moves unchanged duplicate Clawdi declarations into the default
catalog. The directly repeated declarations found in the current workspaces
are:

| Package | Current direct declarations |
| --- | --- |
| `@lobehub/icons` | Web, Desktop: `5.21.0` |
| `@playwright/test` | Web, Desktop: `^1.63.0` |
| `@types/bun` | Web, Desktop, CLI, Shared: `^1.4.2` |
| `@types/node` | Web, Desktop, CLI, sidecar: `^26.6.3` |
| `@x402/core` | Web dev, Shared runtime: `2.27.0` |
| `openapi-fetch` | Web, CLI, Shared: `^0.17.0` |
| `viem` | Web, Shared: `2.56.9` |
| `yaml` | Desktop, CLI: `^2.9.1` |

React, React DOM, React types, TypeScript, Zod, Tailwind, TanStack Query, and
Lucide are already cataloged in Clawdi. The catalog does not eliminate
transitive versions: the current lock still contains, for example, older
`lucide-react`, `viem`, `zod`, `yaml`, and `@types/node` resolutions. Do not
add broad overrides or unrelated upgrades to force those transitive packages.

Keep these declarations outside the default catalog unless another workspace
gets a real direct import:

- `@x402/evm` and `@x402/fetch` are only direct Shared dependencies today.
- `tools/openapi-typescript/package.json` is outside the root workspace glob
  and owns TypeScript `5.9.3` in its own lock; it is not Clawdi product proof.
- The SDK 57 native React exception belongs in the named catalog, not in the
  default catalog.

### Named `expo57` catalog

The candidate's named group is an approved *exception candidate*, not an
approved product dependency set. It records the SDK 57 template/runtime
diagnostic observed by the mobile plan:

| Package | Candidate version |
| --- | --- |
| `expo` | `57.0.26` |
| `react-native` | `0.86.3` |
| `react` / `react-dom` | `19.2.3` |
| `@types/react` | `19.2.18` |
| `@react-native/metro-config` | `0.86.3` |
| `@babel/core` | `7.29.7` |
| `expo-router` | `57.0.24` |
| `@expo/ui` | `57.0.21` |
| native gesture/reanimated/worklets/screen/safe-area/svg peers | candidate exact versions |

The mobile package must use `catalog:expo57` for every package intentionally
in this tuple. It must not use `catalog:` for `react`, `react-dom`, or
`@types/react`, and it must not rely on a root-hoisted React `19.2.8`.

The default and named catalogs may contain different versions of the same
package. That is the point of the exception, but it creates two React regions.
The lock and Metro checks below must prove that the regions do not collapse.

## Shared Dependency Audit

`@clawdi/shared` is a real workspace dependency, not a registry fallback:

- Web declares `@clawdi/shared` in `dependencies`; CLI and Desktop declare it
  in `devDependencies`.
- `@clawdi/shared/api` intentionally exports both `createCloudApiClient` and
  `createHostedApiClient`. Mobile v2 consumes the Cloud client only; preserving
  the Hosted export is a cross-workspace compatibility check, not permission
  to add a Hosted URL or legacy Hosted v1 flow to the mobile app.
- `bun.lock` maps `@clawdi/shared` to `workspace:packages/shared`.
- Shared's exported read clients import `openapi-fetch` at runtime. The x402
  module imports `@x402/evm`, `@x402/fetch`, and `viem` at runtime and exposes
  types from the x402 packages. Keep these in Shared `dependencies`, even
  where a particular import is type-only.
- Shared's `@types/bun` and TypeScript are development-only declarations.

The isolated install must make every consumer resolve the workspace source and
must make Shared resolve its own direct runtime dependencies. A successful
root-hoisted import is not sufficient. In the root-approved container, check
all of the following from the installed tree:

1. `@clawdi/shared` resolves to `packages/shared`, not an npm package.
2. `openapi-fetch`, `@x402/evm`, `@x402/fetch`, and `viem` resolve from the
   Shared dependency context without access to an undeclared root fallback.
3. Web, CLI, and Desktop can load the Shared exports from their own workspace
   contexts.
4. The resolved versions and integrity entries agree with the generated lock.

Use source imports as the declaration authority, not guesses based on package
names. A useful static audit starts with:

```bash
rg -n '^(import|export).*from ["'"']|require\(' packages/shared/src
rg -n '"(dependencies|devDependencies)"|"(openapi-fetch|@x402/core|@x402/evm|@x402/fetch|viem)"' packages/shared/package.json
```

## Filtered Docker Consumers

The managed WhatsApp E2E image installs only the CLI filter but the CLI source
imports Shared. Its current layout is intentional:

- `cli-dependencies` runs `bun install --frozen-lockfile --ignore-scripts
  --filter './packages/cli'`.
- The final E2E stage copies root `node_modules`, CLI `node_modules`, and
  Shared `node_modules` before copying both source trees.
- Commit `c92bad4698c3fbed13005057c235b4f46308acd0` added the Shared copy after
  the pre-fix image failed to load `openapi-fetch` from Shared.

Do not remove that copy because a filtered install succeeded. If the isolated
layout changes its source path, update the Docker packaging contract and prove
the four actual WhatsApp runtime imports again. The sidecar image is separate;
the sidecar source currently does not import Shared, so its runtime image only
copies its own workspace dependency tree.

## React 19.2.3 Isolation Gate

It is technically possible to isolate native React `19.2.3` from default Web
and Electron React `19.2.8`: the mobile workspace must explicitly reference
the named catalog, while Web/Desktop retain `catalog:`. This is not proven by
an unused catalog or by a standalone probe with a different module graph.

The native gate is closed only when all of these use the same actual mobile
resolution and peer context:

1. The mobile manifest declares `react`, `react-native`, and native peers with
   `catalog:expo57`; any mobile `react-dom` and `@types/react` references are
   also explicit named references.
2. The frozen Bun 1.4.2 lock retains `catalog:expo57` in the mobile workspace
   entry and resolves React `19.2.3`, React Native `0.86.3`, and the exact
   peer tuple without an unsupported override.
3. The isolated tree has one physical React identity for the mobile app and
   its React Native/Metro peer graph. A second reachable React `19.2.8` from
   root hoisting fails this gate even if TypeScript passes.
4. Mobile TypeScript strict checking, Expo's dependency/version check, and
   official-wrapper type checks pass without `as any`, suppression, or peer
   overrides.
5. Metro resolves the same React identity for independent iOS and Android
   bundles. Bundling is not native compilation; Android and iOS compilation
   remain separate gates.
6. The chosen UI/native libraries pass their own peer checks against this
   exact tuple. A failed HeroUI Native or UniWind check does not authorize a
   downgrade, type suppression, or a second UI kit.

Expo's [monorepo guidance](https://docs.expo.dev/guides/monorepos/) says SDK
54+ supports isolated dependencies but warns that duplicate React Native
versions are unsupported and duplicate React versions in one app cause runtime
errors. It also says current Expo projects should use `expo/metro-config`
automatic monorepo detection rather than retaining obsolete manual
`watchFolders`/`nodeModulesPaths` configuration. Recheck the versioned [SDK 57
template](https://github.com/expo/expo/blob/sdk-57/templates/expo-template-default/package.json)
and SDK 57 APIs at first use.

## Remaining Acceptance Gates

The following gates are still open for the latest-Bun Wave 1 candidate. A
static catalog closure or a successful standalone probe does not close any
runtime gate.

| Gate | Required evidence | Status in this leaf |
| --- | --- | --- |
| Baseline and Bun pin | Candidate is based on `origin/main` `6705dd9a33ec...`; candidate manifest and generated lock explicitly target Bun `1.4.2`; runner prints `1.4.2`. | Pending root review; origin/main itself remains Bun `1.4.0`. |
| Frozen lock | `bun install --frozen-lockfile --offline --ignore-scripts --dry-run` exits 0 with no manifest/lock diff; lock records default and `expo57` catalog specs, exact versions, integrities, and peer contexts. | Not run here. |
| Dynamic Expo config | `bunx expo config --type public --json` executes `apps/mobile/app.config.js` under Expo 57, with expected plugins/platforms and no secret values. | Static shape reviewed; command pending. |
| Expo SDK check | `bunx expo install --check` and `bunx expo-doctor` complete without mutation; the only accepted mismatch is root TypeScript `7.0.2` versus Expo 57's TypeScript 5.x expectation, with exact output and owner sign-off. React/native-peer mismatches fail. | Pending isolated install. |
| React/Metro identity | Mobile physically resolves one React `19.2.3` region; Web/Desktop retain `19.2.8`; iOS and Android Metro bundles resolve the same mobile identity. | Pending isolated install and both bundle probes. |
| Shared and filtered consumers | Shared runtime imports resolve from its declared dependencies; CLI-filtered WhatsApp image retains the Shared `node_modules` copy and passes its runtime imports. | Static contract retained; runtime/Docker checks pending. |
| Type and native release checks | Mobile strict typecheck, official wrapper/UI peer checks, then independent iOS and Android compilation evidence. | Pending; no native build was run here. |

## Required Root Handoff

Root owns the one bounded verification container. No host install or package
test is evidence for this audit. The container must use the existing pinned
runner image, Bun `1.4.2`, no network, read-only source, dropped capabilities,
an unprivileged user, bounded CPU/memory/PID/time limits, and cleanup of only
its own container/cache state.

The handoff is complete when root records, for the candidate commit and lock:

- immutable root and Hosted base SHAs;
- effective manifest specs and their catalog group for every cataloged package;
- lockfile catalog/default/named entries, resolved versions, integrity values,
  and peer contexts;
- isolated physical module paths and React identity results for Web/Desktop
  and the actual mobile app;
- filtered CLI and WhatsApp E2E runtime import results, including Shared's
  `node_modules` copy;
- focused Shared/Web/Desktop type checks and the existing Docker-backed suites;
- explicit failures or pending native iOS/Android compilation evidence.

Do not claim that a string containing `catalog:` is correct until the effective
spec, resolved lock, peer context, and physical module identity all agree.

Done: the root-owned Bun 1.4.2 isolated verification records the above
evidence, `bun install --frozen-lockfile --offline --ignore-scripts --dry-run`
exits 0 without rewriting manifests or lock, and no Web, Electron, Hosted,
transitive, or unrelated dependency upgrade is included.
