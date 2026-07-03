# API compatibility

This policy describes the API compatibility contract currently in force for
Clawdi Cloud. It is grounded in the FastAPI routes and regression tests in this
repository, especially `backend/app/main.py`,
`backend/app/routes/sessions.py`, `backend/app/routes/admin.py`,
`backend/tests/test_api_version_alias.py`, and
`backend/tests/test_agent_endpoints.py`.

For the domain decision behind the naming, read
[`ADR-0001`](adr/0001-agent-identity-is-the-stable-domain-object.md). For the
system map, read [`architecture.md`](architecture.md#api-surface).

## Canonical surface

`/v1/agents` is the canonical first-party API for Agent identity. New dashboard
and CLI code should use `/v1/agents` and `agent_id` path parameters for
registration, listing, detail reads, updates, ordering, avatars, disconnect, and
sync heartbeat.

`/v1/admin/agents` is the agent-first admin route family for local/admin callers
that use `X-Admin-Key`. Admin routes are live but hidden from the public OpenAPI
schema because `backend/app/routes/admin.py` sets `include_in_schema=False`.

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
`/v1` and once under `/api` with `include_in_schema=False`.
`backend/tests/test_api_version_alias.py` enforces that every `/v1` route has
the `/api` alias and that public OpenAPI advertises only `/v1/*` plus
`/health`.

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

Released CLIs from `v0.7.0` onward must keep working against supported servers.
When in doubt, add a regression test that exercises the old path and payload
before changing the handler.

## Generated clients

OpenAPI feeds the shared TypeScript client used by both web and CLI:

- Source: `packages/shared/src/api/api.generated.ts`
- Ergonomic web aliases: `packages/shared/src/api/schemas.ts`
- CLI aliases: `packages/cli/src/lib/api-schemas.ts`

Never hand-edit `api.generated.ts`. After backend schema changes, run the
workflow in [`backend-development.md`](backend-development.md#generated-api-client)
and commit the generated file with the schema change.

Because `/api/*` aliases and admin routes are hidden from public OpenAPI, the
generated client should use `/v1/*` paths only.

## Do not bulk-rewrite every `/api` string

Some `/api` strings are external protocol shapes, persisted compatibility data,
or test fixtures. They are not Clawdi's legacy route prefix and must not be
rewritten mechanically. Examples in this repository include:

- Discord REST paths such as `/api/v10/*`.
- BlueBubbles-compatible paths such as `/api/v1/*`.
- OpenAI-compatible base URLs ending in `/api/v1`.
- Composio API URLs.
- Captured provider fixtures under `backend/tests/fixtures/`.
- Runtime MITM profile tests that intentionally match external `/api/` paths.

Only rewrite a `/api` string after verifying the owning protocol and call site.

## Change checklist

Before merging API-shape changes:

1. Prefer new first-party code on `/v1/agents` and `agent_id`.
2. Preserve `/v1/environments*` and hidden `/api/*` behavior for old clients.
3. Keep legacy fields, status codes, and error bodies stable.
4. Add or update compatibility tests for old paths.
5. Regenerate and check `packages/shared/src/api/api.generated.ts`.
6. Audit external `/api` strings before broad search-and-replace edits.
