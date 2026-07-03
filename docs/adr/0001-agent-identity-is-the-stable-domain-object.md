# ADR-0001: Agent Identity Is the Stable Domain Object

**Status:** Accepted
**Date:** 2026-07-03
**Deciders:** Clawdi maintainers

## Context

Clawdi stores the agent identity used by sessions, runtime state, channel
links, and API-key scoping in the `agent_environments` table. Existing code and
wire contracts still use names such as `AgentEnvironment` and `environment_id`
because the first implementation modeled the row as a local machine
environment.

That name is now misleading. A Clawdi Agent is the first-class domain object:
one stable agent identity that may refresh its machine metadata over time.
Compatibility still matters, so the current table and legacy wire field names
remain in place until there is a strong reason to migrate them.

## Decision

The first-class domain object is the **Agent**, meaning the stable agent
identity.

`AgentEnvironment` and the `agent_environments` table are legacy persistence
names for that object. `environment_id` is the legacy wire and database field
name for the stable agent id. New product and architecture language should say
**Agent**, **agent identity**, or **agent id** when describing the domain model,
while accepting the legacy names in existing API and database contracts.

The canonical first-party user-facing API surface is `/v1/agents` with
`agent_id` path parameters. `/v1/environments` and legacy `/api/*` paths remain
compatibility aliases with their existing `environment_id` request and response
wire shapes. Session payloads continue to use `environment_id`.

In code today:

- `AgentEnvironment.id` is the stable `agent_id`.
- `Session.environment_id` points at that stable agent identity.
- `registration_key` exists only for legacy/self-managed setup idempotency.

## Invariants

- `agent_id` means `AgentEnvironment.id`.
- `agent_id` is the identity and remains stable across re-registrations.
- `machine_id`, `machine_name`, `os`, and `agent_version` are refreshable
  metadata. They are never identity.
- `display_name` is the user's dashboard override.
- `default_name` is the caller/runtime-provided default Agent name.
- User-facing labels use one fallback chain across Cloud, legacy, and
  connected agents: `display_name -> default_name -> name -> machine_name ->
  agent_type`. `name` is a compatibility response alias, not a separate
  identity source. Ownership controls badges, available actions, and lifecycle
  chrome only; it must not change the primary label fallback.
- `registration_key` is only a legacy/self-managed setup idempotency key. The
  current self-managed registration key is machine-derived from `machine_id`
  and `agent_type`.
- `(user, machine_id)` must never be treated as identity.
- `(user, machine_id, agent_type)` must never be treated as identity.
- Rows with `registration_key IS NULL` are explicit-identity rows. They are
  caller-owned and must not be deleted by user-facing disconnect flows.
- User-facing disconnect can remove legacy/self-managed rows that have a
  `registration_key`, while preserving historical sessions through the existing
  nullable `sessions.environment_id` relationship.

## Registration Contract

Self-managed agents register through `POST /v1/agents`.

That endpoint derives a legacy registration key from the submitted machine
metadata and is idempotent for that user's setup flow. Re-registration refreshes
machine metadata and returns the same stable `AgentEnvironment.id`.
`POST /v1/environments` remains a byte-compatible alias for released CLIs.

Hosted control planes register through the admin API. `/v1/admin/agents` accepts
`agent_id` for agent-first callers. `/v1/admin/environments` remains intact for
the hosted control plane until that separate service migrates.

They may supply an explicit caller-owned stable id. The supplied id is the
agent identity. Re-registration with the same user and same id refreshes
metadata in place. Reusing an id that already belongs to another user is a
conflict. Explicit-identity rows use `registration_key = NULL`.

## Consequences

- Documentation should describe the domain object as Agent or agent identity,
  even where code still says `AgentEnvironment`.
- New code should not derive ownership, identity, or uniqueness from machine
  metadata.
- New first-party clients should call `/v1/agents`. Released clients that call
  `/v1/environments` or `/api/*` remain supported.
- Public API clients should continue to treat existing `environment_id` fields
  as stable agent ids wherever those fields remain in compatibility and session
  payloads.
- Deprecated environment fields `hosted_managed` and `hosted_deployment_id`
  remain on `EnvironmentResponse`, but their compatibility meaning is now
  intentionally narrow: they reflect only direct hosted runtime desired state
  stored by Cloud API. They must not infer ownership from `machine_id`,
  `machine_name`, or sibling runtime rows. Dashboard and control-plane
  consumers should use ownership sets for Cloud/legacy/connected chrome.
- User-facing deletion and disconnect behavior must preserve caller-owned
  explicit identities.
- The legacy database and wire names remain supported for compatibility.

## Migration Direction

These are non-binding future improvements, not requirements for the current
decision:

- Rename service-layer concepts toward agent identity, for example
  `register_agent_identity`.
- Add a runtime manifest `agentId` alias for the current legacy field.
- Consider a database/table rename only much later, after API and service
  terminology have settled.

Database and table renames are explicitly deferred.
