# WhatsApp Native Baileys Cleanup Audit

Status: review record for PR #719 and its dependent cleanup
Date: 2026-08-02

This audit compares `origin/main` at `165b5d07e` with PR #719 at `96d337b9c`
and the dependent cleanup worktree. It covers files whose path contains
`whatsapp` or `egress` and every tracked text file that references WhatsApp.
Generated API output is checked separately after regeneration.

## Reproduce The Inventory

```bash
git ls-tree -r --name-only origin/main | rg -i 'whatsapp|egress'
git grep -l -I -i -E 'whatsapp|WHATSAPP' origin/main -- \
  ':!packages/shared/src/api/api.generated.ts'
rg --hidden --files --glob '!.git' | rg -i 'whatsapp|egress'
rg --hidden -l -i 'whatsapp' --glob '!.git' \
  --glob '!packages/shared/src/api/api.generated.ts'
```

Done: the origin reference inventory reports 85 non-generated files and 40
dedicated WhatsApp/egress paths. The cleanup worktree reports 90
non-generated references without the deleted compatibility files.

Decision labels:

- **A — keep:** required by the physical provider transport, synthetic Noise
  boundary, identity/ownership, durable inbox/outbox, generic egress, or
  fail-closed authorization and compatibility checks.
- **B — delete:** old hosted compatibility, application relay, public
  credential authority, or unreachable duplicate configuration/tests.
- **C — refactor/document:** behavior stays, but naming or ownership moves to
  make the two socket roles explicit.

## Dedicated WhatsApp And Egress Paths

| Origin/main path set | Decision | Evidence and cleanup result |
| --- | --- | --- |
| `backend/app/routes/channel_routers/whatsapp.py` | A | Keeps only the Link-bearer websocket, synthetic identity lookup, Noise session, durable inbox replay, and revocation checks. Graph, webhook, media, and public credential routes are removed. |
| `backend/app/services/whatsapp_baileys.py`, `whatsapp_noise.py`, `whatsapp_runtime_types.py`, `whatsapp_wabinary_tokens.py` | A | Noise/Signal/WABinary, JID alias policy, proto fidelity, synthetic credential issuance, and relay policy. The data-only generated token table includes protocol token `"meta"`; it is not a hosted API integration. |
| `backend/app/services/whatsapp_native_transport.py`, `whatsapp_sidecar_registry.py` | C | Narrow physical-provider HTTP client/registry retained; adapter renamed to `WhatsAppProviderTransportAdapter`, and the registry owns the provider ingress pump. |
| `backend/app/services/whatsapp_provider_bridge.py` | A, new | Centralizes one transport registration per account, authorized raw/IQ forwarding, exact proto delivery, and physical event persistence. |
| `backend/app/services/whatsapp_media_reupload.py` | B, deleted | Provider media download/decrypt/upload conversion belonged to the removed hosted compatibility path. |
| `backend/app/services/whatsapp_shared_runtime.py` | B, deleted | Application-level bot/runtime relay façade competed with stock native plugins and obscured the physical socket owner. |
| `backend/tests/test_whatsapp_*.py` | A/C | Existing protocol/Noise/transport tests are trimmed to preserved behavior; provider-bridge tests are added. Old Graph/webhook/media/shared-runtime assertions are removed. The smoke test remains explicitly opt-in and creates no production connection during normal tests. |
| `backend/alembic/versions/2d4c8e1b7a90_clawdi_native_channels.py` | A | Existing durable channel, synthetic credential, and auth-cert tables remain required. No destructive migration is introduced. |
| `backend/alembic/versions/c4e8f1a2b3d5_rename_hosted_runtime_egress_columns.py`, `backend/tests/test_hosted_runtime_egress_migration.py` | A | Generic egress schema history, not WhatsApp product code. |
| `apps/web/src/hosted/v2/channels/whatsapp-credential-cache.ts` | B, deleted | Cached the removed public credential API response. Its hooks and query keys are also removed. |
| `packages/cli/egress-addon/clawdi_egress_addon.py` | A | Single provider-neutral matcher/rewrite engine. Source invariant rejects provider constants. |
| `packages/cli/src/runtime/egress-env.ts`, `egress-profiles.ts`, `hosted-egress-profiles.ts`, `transparent-egress.ts` and their tests | A | Generic schema, secret references, redirect, and profile materialization shared by all providers. No WhatsApp branch is added. |
| `packages/cli/src/runtime/whatsapp-egress.ts`, `whatsapp-upstream-contract.ts` | A | Provider-only profile builder plus the exact marker and metadata contract consumed by production. Fixed-artifact E2E evidence lives in its CI-wired script, not in runtime constants. Normal runtime projection consumes the builder without a master feature flag. |
| `packages/whatsapp-baileys-sidecar/**` | A/C | Package name retained for build stability and documented as the one physical-provider transport. `runtime.ts` is the only production `makeWASocket`; a single WAL/FULL SQLite store holds auth/Signal/retry/inbox state and immutable account metadata under SQLite exclusive locking on a compatible local filesystem, rejecting symlinked state paths before open. At-rest encryption remains a deployment infrastructure requirement. The private bearer HTTP operations and byte-safe node codec remain. Demo multi-file auth, mutable version discovery, PID locking, and JSON spool/cache files are absent from production. |
| `docs/designs/whatsapp-baileys-sidecar-runtime.md` | C | Current topology and exact upstream proposal. |
| `docs/egress-channel-transport-architecture.md` | C | Replaced stale proxy/Graph research with the current generic engine and three provider builders. |

## Origin/Main References Removed In Place

The following references lived in files not named after WhatsApp. Their
WhatsApp-specific sections are **B**, while unrelated provider code in the same
files is preserved:

- `backend/app/core/config.py`: hosted Graph base setting.
- `backend/app/routes/channel_routers/public.py`: public credential mint/list/
  revoke and auth-cert authority routes; the authenticated internal runtime
  projection remains **A**.
- `backend/app/routes/channel_routers/shared.py`: Graph text extraction helper.
- `backend/app/schemas/channel.py`: public credential request/response DTOs.
- `backend/app/services/channel_config.py`: Graph base URL configuration.
- `backend/app/services/channels.py`: Cloud payload conversion/send, webhook
  assumptions, and media fallback; generic delivery and the narrow physical
  provider dispatch remain **A**.
- `backend/app/services/channel_debug_events.py`: old shared-runtime health
  name; physical transport health remains **C**.
- `backend/pyproject.toml` and `backend/scripts/type_governance.py`: dependency
  and exemption used only by removed media conversion.
- `apps/web/src/hosted/sensitive-boundaries.test.ts`, channel hooks, and channel
  query cache: public credential cache/mutation coverage.
- `packages/cli/src/commands/runtime.ts`, `runtime/channels.ts`, and
  `runtime/manifest.ts`: public credential mint/write and Hermes application
  adapter projection. Stock-native auth materialization and ordinary
  Telegram/Discord projection stay **A**.
- backend, Web, and CLI tests: old compatibility expectations are deleted or
  replaced with source/topology invariants.

## Complete Current Reference Set

Every remaining non-generated file that mentions WhatsApp is assigned below.

**A — build, package, history, and contributor entry points**

```text
AGENTS.md
CHANGELOG.md
README.md
.github/workflows/clean-test-runner-ci.yml
.github/workflows/client-ci.yml
apps/web/Dockerfile
bun.lock
scripts/test.sh
docs/clean-test-runner.md
packages/cli/tests/clean-test-runner.test.ts
```

These references build/test the retained package or preserve release history;
they are not product transport implementations.

**A — Web discovery and activation**

```text
apps/web/e2e/hosted-smoke.pw.ts
apps/web/src/components/entity-icon.tsx
apps/web/src/components/entity-icon.test.tsx
apps/web/src/hosted/v2/README.md
apps/web/src/hosted/v2/channels/channel-default-path.test.ts
apps/web/src/hosted/v2/channels/channel-finish-line.test.ts
apps/web/src/hosted/v2/channels/channel-linking.logic.ts
apps/web/src/hosted/v2/channels/channel-linking.logic.test.ts
apps/web/src/hosted/v2/channels/channel-pairing-ux.test.ts
apps/web/src/hosted/v2/channels/channel-providers.ts
apps/web/src/hosted/v2/channels/channel-providers.test.ts
apps/web/src/hosted/v2/channels/channels-page.logic.ts
apps/web/src/hosted/v2/channels/channels-page.logic.test.ts
apps/web/src/lib/navigation-model.ts
docs/v2-ui-ux-final-sweep.md
```

WhatsApp remains a normal provider/icon. Agent Link and Pair entry points use
the same account, runtime, binding, and provider-availability admission rules as
the enabled backend path; Custom onboarding still creates inventory first.

**A/C — backend production ownership and transport**

```text
backend/alembic/versions/2d4c8e1b7a90_clawdi_native_channels.py
backend/app/core/config.py
backend/app/main.py
backend/app/models/channel.py
backend/app/routes/channel_routers/public.py
backend/app/routes/channel_routers/whatsapp.py
backend/app/routes/channels.py
backend/app/schemas/admin.py
backend/app/schemas/channel.py
backend/app/services/channel_debug_events.py
backend/app/services/channels.py
backend/app/services/whatsapp_baileys.py
backend/app/services/whatsapp_native_transport.py
backend/app/services/whatsapp_noise.py
backend/app/services/whatsapp_provider_bridge.py
backend/app/services/whatsapp_runtime_types.py
backend/app/services/whatsapp_sidecar_registry.py
backend/app/services/whatsapp_wabinary_tokens.py
backend/pyproject.toml
backend/scripts/mock_deploy_api.py
backend/scripts/type_governance.py
```

`mock_deploy_api.py` and admin/schema references carry false readiness or
provider enum fixtures. `main.py` owns physical transport lifecycle. The rest
are the preserved A boundary or the narrow C naming described above.

**A/C — backend verification**

```text
backend/tests/e2e/test_channels_blackbox.py
backend/tests/test_channel_debug_events.py
backend/tests/test_channel_inbox.py
backend/tests/test_channels.py
backend/tests/test_whatsapp_baileys.py
backend/tests/test_whatsapp_baileys_smoke.py
backend/tests/test_whatsapp_native_transport.py
backend/tests/test_whatsapp_noise.py
backend/tests/test_whatsapp_provider_bridge.py
backend/tests/test_whatsapp_sidecar_registry.py
```

These cover absence of public authority, synthetic credential isolation,
Noise/Signal behavior, aliases, durable ingress/outbound, one transport owner,
private sidecar operations, and revocation.

**A/C — CLI runtime projection and verification**

```text
docs/adr/0003-runtime-bundle-media-type-is-the-render-contract.md
packages/cli/src/commands/channel.ts
packages/cli/src/commands/runtime.ts
packages/cli/src/runtime/channels.ts
packages/cli/src/runtime/manifest-reconciliation.test.ts
packages/cli/src/runtime/manifest-source.ts
packages/cli/src/runtime/manifest.ts
packages/cli/src/runtime/runtime-bundle-v2.test.ts
packages/cli/src/runtime/whatsapp-egress.ts
packages/cli/src/runtime/whatsapp-upstream-contract.ts
packages/cli/tests/commands/runtime.test.ts
packages/cli/tests/egress_addon/clawdi_egress_addon_test.py
packages/cli/tests/runtime-egress-profiles.test.ts
packages/cli/tests/runtime-whatsapp-egress.test.ts
packages/cli/tests/runtime.test.ts
```

The command/manifest files retain only stock native-plugin auth
projection and cleanup of Clawdi-owned auth directories. They neither create a
second physical socket nor install a custom WhatsApp adapter.

**A/C — physical-provider package, including files without product strings**

```text
packages/whatsapp-baileys-sidecar/package.json
packages/whatsapp-baileys-sidecar/tsconfig.json
packages/whatsapp-baileys-sidecar/src/audited-version.ts
packages/whatsapp-baileys-sidecar/src/config.ts
packages/whatsapp-baileys-sidecar/src/config.test.ts
packages/whatsapp-baileys-sidecar/src/index.ts
packages/whatsapp-baileys-sidecar/src/json-bytes.ts
packages/whatsapp-baileys-sidecar/src/json-bytes.test.ts
packages/whatsapp-baileys-sidecar/src/runtime.ts
packages/whatsapp-baileys-sidecar/src/runtime.test.ts
packages/whatsapp-baileys-sidecar/src/server.ts
packages/whatsapp-baileys-sidecar/src/server.test.ts
packages/whatsapp-baileys-sidecar/src/sqlite-state.ts
packages/whatsapp-baileys-sidecar/src/sqlite-state.test.ts
packages/whatsapp-baileys-sidecar/src/types.ts
```

**C — current owner documentation**

```text
docs/architecture.md
docs/designs/native-channels-product-model.md
docs/designs/whatsapp-native-baileys-cleanup-audit.md
docs/designs/whatsapp-baileys-sidecar-runtime.md
docs/egress-channel-transport-architecture.md
docs/plans/channels-native-backend.md
```

The retired user-file proposal remains at
`docs/designs/channel-runtime-manifest.md` as historical context; it is not a
current owner document.

## Residual Boundaries

Intentional residual references are:

- historical changelog and “removed compatibility” documentation;
- 404/source-invariant tests proving deleted public routes stay absent;
- the explicitly opt-in Noise smoke fixture's auth-cert serialization;
- user-owned legacy runtime config fixtures proving Clawdi does not erase
  unmanaged configuration;
- the WABinary data token `"meta"` required for protocol decoding.

No production WhatsApp source contains a hosted Graph/Cloud route, payload
converter, media reupload, custom OpenClaw connector, Hermes
`BasePlatformAdapter`, or second `makeWASocket`.

Done:

```bash
bun test packages/cli/tests/runtime-whatsapp-egress.test.ts \
  packages/cli/tests/runtime-egress-profiles.test.ts
python3 -m unittest packages/cli/tests/egress_addon/clawdi_egress_addon_test.py
bun run --cwd packages/whatsapp-baileys-sidecar typecheck
bun test packages/whatsapp-baileys-sidecar/src
cd backend && uv run pytest -q tests/test_whatsapp_native_transport.py \
  tests/test_whatsapp_sidecar_registry.py
```

The focused CLI profile suites report 24 passing tests, the generic addon
suite reports 21, the repair-specific sidecar suite reports 28, and the
focused backend transport/registry suite reports 34. On a newly migrated
throwaway pgvector database, the latest-main channel/Baileys suite plus the
WhatsApp transport/registry/bridge/Noise suites report 455 passing tests. The
source invariants report one production physical socket owner, no
demo multi-file auth or dynamic Web-version fetch, no legacy application
connector, no hosted Graph/Cloud WhatsApp surface, no provider constants in
the generic addon, and no WhatsApp runtime master enablement switch. The
fixed-artifact E2E is CI-wired; the real live-account message drill has not
been performed.
