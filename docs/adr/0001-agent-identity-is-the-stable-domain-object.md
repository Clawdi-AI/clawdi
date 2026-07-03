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
Compatibility still matters, so the current table and API field names remain in
place until there is a strong reason to migrate them.

## Decision

The first-class domain object is the **Agent**, meaning the stable agent
identity.

`AgentEnvironment` and the `agent_environments` table are legacy persistence
names for that object. `environment_id` is the legacy wire and database field
name for the stable agent id. New product and architecture language should say
**Agent**, **agent identity**, or **agent id** when describing the domain model,
while accepting the legacy names in existing API and database contracts.

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

Self-managed agents register through `POST /v1/environments`.

That endpoint derives a legacy registration key from the submitted machine
metadata and is idempotent for that user's setup flow. Re-registration refreshes
machine metadata and returns the same stable `AgentEnvironment.id`.

Hosted control planes register through the admin API.

They may supply an explicit caller-owned stable id. The supplied id is the
agent identity. Re-registration with the same user and same id refreshes
metadata in place. Reusing an id that already belongs to another user is a
conflict. Explicit-identity rows use `registration_key = NULL`.

## Consequences

- Documentation should describe the domain object as Agent or agent identity,
  even where code still says `AgentEnvironment`.
- New code should not derive ownership, identity, or uniqueness from machine
  metadata.
- Public API clients should continue to treat existing `environment_id` fields
  as stable agent ids.
- User-facing deletion and disconnect behavior must preserve caller-owned
  explicit identities.
- The legacy database and wire names remain supported for compatibility.

## Migration Direction

These are non-binding future improvements, not requirements for the current
decision:

- Rename service-layer concepts toward agent identity, for example
  `register_agent_identity`.
- Add an agent-first admin API such as `/v1/admin/agents` while keeping the
  existing environment endpoint compatible.
- Add a runtime manifest `agentId` alias for the current legacy field.
- Consider a database/table rename only much later, after API and service
  terminology have settled.

Database and table renames are explicitly deferred.
