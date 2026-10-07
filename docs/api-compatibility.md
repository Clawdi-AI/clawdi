# API compatibility

This policy describes the API compatibility contract currently in force for
Clawdi. It is grounded in the FastAPI routes and regression tests in this
repository, especially `backend/app/main.py`,
`backend/app/routes/sessions.py`, `backend/app/routes/admin.py`,
`backend/tests/test_api_version_alias.py`, and
`backend/tests/test_agent_endpoints.py`.

For the domain decision behind the naming, read
[`ADR-0001`](adr/0001-agent-identity-is-the-stable-domain-object.md). For the
system map, read [`architecture.md`](architecture.md#api-and-identity).

## Canonical surface

`/v1` is the canonical Clawdi API namespace. Hosted runtime “bundle v2” is
a media-type and schema contract served by `GET /v1/runtime/manifest`; it is not
a replacement `/v2` URL namespace.

`/v1/agents` is the canonical first-party API for Agent identity. New dashboard
and CLI code should use `/v1/agents` and `agent_id` path parameters for
registration, listing, detail reads, updates, ordering, avatars, disconnect, and
sync heartbeat.

`/v1/admin/agents` is the agent-first admin route family for local/admin callers
that use `X-Admin-Key`. Admin routes are live but hidden from the public OpenAPI
schema because `backend/app/routes/admin.py` sets `include_in_schema=False`.

`GET /v1/channels` is the user control-plane channel list and rejects
environment-bound Agent API keys. Managed runtimes receive channel desired state
only through the strict bundle returned by `GET /v1/runtime/manifest`.
The removed environment-bound response variant was not used by released Hosted
init/watch consumers; unbound CLI control-plane channel operations remain
supported.

The stable agent id is still stored in `agent_environments.id`; code and older
wire contracts still use `AgentEnvironment` and `environment_id` names in many
places. Treat `environment_id` as the legacy wire name for the same stable
Agent identity wherever that field still exists.

## Compatibility aliases

`/v1/environments*` endpoints are deprecated compatibility aliases. Public
environment routes are marked `deprecated=True` in OpenAPI and invoke the same
shared helpers as the corresponding agent routes. They keep existing
`environment_id` request and response shapes.

`/v1/admin/environments*` endpoints are the admin compatibility aliases. They
delegate to the same admin helpers as `/v1/admin/agents*`, but admin routes are
hidden from public OpenAPI.

Legacy `/api/*` mounts are hidden aliases for clients built before the `/v1`
prefix migration. `backend/app/main.py` mounts every versioned router once under
`/v1` and, where compatibility requires it, once under `/api` with
`include_in_schema=False`.
`backend/tests/test_api_version_alias.py` enforces that every `/v1` route has
the expected `/api` alias.

The declarative runtime observation companion is the one direct clean-v2
surface. Its provisioning, ingestion, retirement, and consumer operations are
mounted only under `/v2/runtime/*`; they have no `/v1` or `/api` alias. Public
OpenAPI therefore advertises `/v1/*`, the explicit `/v2/runtime/*` companion,
and `/health`.

## Additive-only contract

Compatibility surfaces are additive-only:

- Do not remove or rename pre-existing request fields, response fields,
  response shapes, status codes, or error bodies.
- Do not change the semantics of existing fields. For example,
  `environment_id` remains the stable agent id on legacy/session payloads.
- New optional response fields are allowed when old clients can ignore them.
  Existing examples include `name`, `default_name`, and `explicit_identity`.
- New canonical agent routes may expose agent-shaped responses, but legacy
  environment aliases must preserve their environment-shaped response fields.

Released wire surfaces must keep working against supported servers. Compatibility
is defined by the route and payload schema, plus an explicit capability when
behavior must be negotiated; a CLI product version is not a compatibility
selector. When in doubt, add a regression test that exercises the old path and
payload before changing the handler.

## Agent profiles

`GET/PUT /v1/agents/{agent_id}/profiles` reads and reconciles an Agent's
profile inventory. PUT accepts `{complete, profiles: [{upstream_key, is_default}]}`;
only a complete inventory marks missing profiles `removed`. Removed profiles
retain their sessions. Responses include stable profile UUIDs, keys, derived
`is_default`, state, and session counts. By owner decision, profile responses omit
`online`, `last_seen_at`, `display_name`, `upstream_key`, `first_seen_at`, and
`removed_at`; profile identity and labels come from `profile_key`.
Profile writes require `sessions:write` or `skills:write` and the existing
Agent credential and machine fences. The v1 heartbeat contract is unchanged.

The default Cloud key is the empty string. Session batch requests accept a
batch-level `profile_key`; local-ID content endpoints accept it in their existing
query, form, or JSON body. Omitted keys resolve one matching session across
profiles, create new metadata under the default profile when no session matches,
and reject ambiguity with HTTP 409 `profile_required` on single-session endpoints.
Batches report ambiguous IDs in the per-item `rejected` list; unaffected items
continue. Generation commits address their generation's Session directly.
Deleted attributed
sessions still resolve their suppression profile for older clients. Session
lists accept and expose `profile_key`; responses omit `profile_display_name`.
Session batches select profiles only at batch level, not on individual items.

`POST /v1/agents/{agent_id}/profiles/{profile_key}/attribute-sessions` moves
OpenClaw default-profile metadata and suppressions for up to 1,000 local IDs.
The Hermes sibling `/rename` accepts `{new_upstream_key}` and preserves the
source profile UUID while moving sessions and suppressions in place. Both
operations preserve content bytes, object references, hashes, and session UUIDs;
an existing rename destination returns HTTP 409 `profile_conflict` if it contains
sessions or suppressions. Empty destinations are replaced to support older CLIs
that PUT inventory before rename; keep this branch until the CLI floor reaches
0.15.5. New CLI reconciliation renames before PUT inventory. Both metadata
move operations require `sessions:write`; `skills:write` alone is insufficient.

The migration adds defaulted profile columns without session backfill and builds
the new unique indexes concurrently, retaining the old uniqueness and upsert target
for old API binaries. Transactional DDL uses a three-second lock timeout and is
retryable. Attaching the new Session index, dropping the old constraint and
switching upserts are a separate contract release. Until then, cross-profile
local-ID collisions are rejected per item without overwriting existing sessions.
Storage keys retain their existing paths through attribution and rename. Run the
Docker migration and compatibility checks:

```bash
scripts/test.sh backend tests/test_agent_profiles.py tests/test_agent_profiles_migration.py
```

Done: both test files pass, including unchanged stored content and old-client
resolution with zero, one, and multiple matching sessions.

## Personal-key issuance exception

`POST /v1/auth/keys` and its `/api` alias permanently return 410. Users can no
longer create personal API keys. The detail directs users to `clawdi auth login`
(or `--no-open` on a server) and states that existing keys keep working until
revoked. This is an intentional security exception to additive compatibility.
The dashboard now offers only key listing and revocation.

Legacy CLI `/cli/auth/device` and `/cli/auth/approve` also return 410 with upgrade
guidance. OAuth login and existing keys remain supported. List and internal
creation responses include nullable `scopes` and `expires_at`; `scopes: null`
denotes full access for legacy/internal keys. Admin issuance still permits
omitted scopes and expiry, with optional `expires_in_days` between 1 and 365.
See the [backend key contract](backend-development.md#api-key-issuance) for the
exact retirement message and retained operations.

Done: `scripts/test.sh backend tests/test_auth_keys.py tests/test_cli_auth_device_flow.py tests/test_admin_endpoints.py`
passes for canonical and legacy issuance routes.

## Generated clients

OpenAPI feeds the shared TypeScript client used by both web and CLI:

- Source: `packages/shared/src/api/api.generated.ts`
- Ergonomic web aliases: `packages/shared/src/api/schemas.ts`
- CLI aliases: `packages/cli/src/lib/api-schemas.ts`

Never hand-edit `api.generated.ts`. After backend schema changes, run the
workflow in [`backend-development.md`](backend-development.md#generated-api-client)
and commit the generated file with the schema change.

Because `/api/*` aliases and admin routes are hidden from public OpenAPI, the
generated client should use `/v1/*` paths for legacy contracts and direct
`/v2/runtime/*` paths for the runtime observation companion.

## API change playbook

When adding an optional response field:

1. Update the Pydantic response schema in `backend/app/schemas/`. Route
   handlers should return the new field only through that schema, not by
   constructing ad hoc response dictionaries.
2. Keep the field optional or give it a backwards-compatible default. Do not
   rename, remove, or change the semantics of existing fields.
3. Add or update a focused backend test for the canonical `/v1/*` path.
4. Add or update compatibility coverage for old paths that serve the same
   behavior, especially deprecated `/v1/environments*` aliases and hidden
   `/api/*` aliases when the changed route is mounted there.
5. Regenerate the generated TypeScript client:

   ```bash
   bun run generate-api
   ```

6. Check that the committed generated client matches the backend schema:

   ```bash
   cd backend
   uv run python scripts/check_generated_api.py
   ```

7. Manually review `packages/shared/src/api/schemas.ts` when frontend code uses
   an ergonomic alias for the changed schema, or when adding a new response
   shape that should get one.
8. Manually review `packages/cli/src/lib/api-schemas.ts` when CLI code imports
   or narrows the changed schema, or when a CLI command should start using the
   new optional field.
9. Run focused compatibility tests, then the backend verification flow in
   [`backend-development.md`](backend-development.md#verification):

   ```bash
   cd backend
   uv run pytest tests/test_api_version_alias.py -q
   uv run pytest tests/test_agent_endpoints.py -q
   ```

## Do not bulk-rewrite every `/api` string

Some `/api` strings are external protocol shapes, persisted compatibility data,
or test fixtures. They are not Clawdi's legacy route prefix and must not be
rewritten mechanically. Examples in this repository include:

- Discord REST paths such as `/api/v10/*`.
- OpenAI-compatible base URLs ending in `/api/v1`.
- Composio API URLs.
- Captured provider fixtures under `backend/tests/fixtures/`.
- Runtime egress profile tests that intentionally match external `/api/` paths.

Only rewrite a `/api` string after verifying the owning protocol and call site.

## Change checklist

Before merging API-shape changes:

1. Prefer new first-party code on `/v1/agents` and `agent_id`.
2. Preserve `/v1/environments*` and hidden `/api/*` behavior for old clients.
3. Keep legacy fields, status codes, and error bodies stable.
4. Add or update compatibility tests for old paths.
5. Regenerate and check `packages/shared/src/api/api.generated.ts`.
6. Audit external `/api` strings before broad search-and-replace edits.

## Connector MCP account management consolidation

The native `connector_account_list`, `connector_account_update`, and
`connector_account_delete` tools are removed in favor of the session's
`COMPOSIO_MANAGE_CONNECTIONS`. This is an intentional MCP tool removal; the
`/v1/connectors` dashboard API remains supported. Refresh cached `tools/list`
definitions and update Agent instructions before using the consolidated surface.
Use explicit `action: "list"` for reads and exact discovered account IDs for
`rename` and `remove`. Empty-alias clearing is not established by the supplied
multi-account MCP schema; the dashboard API still supports it.

Hosted `clawdi` version `1` remains the existing compatibility label. Its packaged
Skill and catalog digest are updated together with the current generic Skill.
Deploy the updated CLI/Skill instructions and refresh MCP tool lists when removing
these backend tools; a backend-only update cannot refresh already-installed Skills.
