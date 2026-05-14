# Project + Agent Bindings Design

**Status:** draft for PR #88 pre-implementation alignment  
**Last updated:** 2026-05-14  
**Owner:** product + platform

## Summary

This document replaces the legacy graph/mount vocabulary with a simpler
model:

- `Project` is the collaboration and data ownership boundary.
- `Agent` is the runtime boundary that reads from one or more projects.
- Every agent has exactly one primary project and zero or more context
  projects.

Project composition is not project-to-project. Composition happens only
when an agent runs.

## Goals

1. Use `Project + Agent` as the only user-facing model.
2. Remove legacy boundary terminology from product and docs.
3. Ensure each agent has one primary project for default reads/writes.
4. Support one agent bound to multiple projects in v1:
   one primary plus zero or more context projects.
5. Keep sharing and membership independent from agent binding:
   accepting a shared project grants access, then users bind that
   project to agents.
6. Keep default write behavior deterministic:
   writes go to the agent primary project unless explicitly overridden.
7. Enforce safe multi-project vault resolution with provenance and
   explicit conflict handling.
8. Preserve validated PR #88 flows:
   links, invitations, inbox, member management, revoke/remove/unshare,
   vault conflict safety, and agent handoff JSON.

## Non-goals

1. No nested project composition. Projects do not include projects.
2. No implicit write fan-out across multiple projects.
3. No automatic conflict override during vault/key collisions.
4. No test implementation changes in this planning step.
5. No backend/CLI/web runtime implementation in this planning step.

## User Model

## Core Objects

- `Project`
  - Contains skills, vault metadata/content, and future memory/session
    data.
  - Is owned by one account and may be shared with other accounts.
  - May be a Personal/Home project, but it is still a normal project.
- `Agent`
  - Represents one runnable assistant identity or environment endpoint.
  - Has a project binding set that defines its read/write boundary.
- `Agent Project Binding`
  - Exactly one binding marked as `primary`.
  - Zero or more bindings marked as `context`.
  - Context bindings have explicit priority/order.

## Mental Model

- Sharing answers: "Who can access this project?"
- Binding answers: "Which projects can this agent use at runtime?"
- Primary answers: "Where do default writes go?"

## Data Model Proposal

The names below are proposed external model names. Internal table names
can be introduced with compatibility layers if needed.

## Entities

1. `projects`
   - `id`
   - `owner_user_id`
   - `name`
   - `slug`
   - `description`
   - `created_at`, `updated_at`, `archived_at`
2. `project_memberships`
   - `id`
   - `project_id`
   - `member_user_id`
   - `role` (`owner`, `editor`, `viewer`)
   - `accepted_at`, `revoked_at`
3. `project_share_links`
   - `id`
   - `project_id`
   - `token_hash`
   - `created_by_user_id`
   - `expires_at`, `revoked_at`
4. `project_invitations`
   - `id`
   - `project_id`
   - `email`
   - `role`
   - `invited_by_user_id`
   - `accepted_at`, `revoked_at`
5. `agents`
   - `id`
   - `owner_user_id`
   - `name`
   - `agent_type`
   - `created_at`, `updated_at`
6. `agent_project_bindings`
   - `id`
   - `agent_id`
   - `project_id`
   - `binding_type` (`primary`, `context`)
   - `priority` (integer; lower = earlier resolution)
   - `default_write_enabled` (true only for primary)
   - `created_by_user_id`
   - `created_at`, `updated_at`

## Constraints

1. One primary binding per agent:
   unique partial index on `agent_id` where `binding_type='primary'`.
2. No duplicate binding to same project for same agent:
   unique on `(agent_id, project_id)`.
3. Context order uniqueness:
   unique on `(agent_id, binding_type, priority)`.
4. Primary project must be writable by agent owner (owner/editor
   membership).
5. Context project may be read-only (`viewer`) and must never be default
   write target.
6. No project-to-project edges in schema.

## Runtime and Vault Resolution Rules

## Binding Boundary

- Runtime composition is computed at agent boundary only.
- Effective read set = primary project + ordered context projects.
- Effective default write target = primary project only.

## Resolution Order

1. Primary project first.
2. Context projects in explicit binding priority order.
3. If key appears in multiple non-primary context projects at the same
   priority, treat as conflict.

## Conflict Handling

- Default behavior: block on conflict and return structured error.
- Explicit override path: caller may pass an allow flag.
- Every resolve response includes provenance:
  - winning project id/name
  - skipped candidates
  - reason (`precedence`, `role_read_only`, `conflict_blocked`)
- Debug mode must expose full candidate chain without exposing secret
  values in logs by default.

## Write Rules

- Unqualified writes go to primary project.
- Writes to context projects require explicit target and write role.
- Viewer-shared context projects are read/context only by default.

## API Changes (Proposed)

## Projects and Sharing

1. `POST /api/projects`
2. `GET /api/projects`
3. `GET /api/projects/{project_id}`
4. `POST /api/projects/{project_id}/share-links`
5. `POST /api/projects/{project_id}/invitations`
6. `GET /api/projects/{project_id}/members`
7. `DELETE /api/projects/{project_id}/members/{member_id}`
8. `POST /api/projects/{project_id}/unshare`

## Inbox / Accept

1. `POST /api/inbox/accept-link`
2. `POST /api/inbox/accept-invitation`

Accept responses return membership state and binding suggestion status,
but do not auto-bind unless requested with explicit agent ids.

## Agent Bindings

1. `GET /api/agents/{agent_id}/project-bindings`
2. `PUT /api/agents/{agent_id}/project-bindings/primary`
3. `POST /api/agents/{agent_id}/project-bindings/context`
4. `PATCH /api/agents/{agent_id}/project-bindings/context/reorder`
5. `DELETE /api/agents/{agent_id}/project-bindings/{binding_id}`

## Vault Resolve / Write

1. `POST /api/agents/{agent_id}/vault/resolve`
2. `POST /api/agents/{agent_id}/vault/write`

These endpoints enforce agent-boundary composition and return provenance.

## CLI Changes (Proposed)

## Command Families

1. `clawdi project ...` for project lifecycle and sharing.
2. `clawdi inbox ...` for accepting links/invitations.
3. `clawdi agent projects ...` for binding primary/context projects.
4. `clawdi vault ... --agent <agent>` for runtime resolution.

## Example Commands

```bash
clawdi project create "Engineering"
clawdi project share engineering --label "demo handoff"
clawdi inbox accept https://clawdi.ai/share/<token>
clawdi agent projects set-primary atlas --project personal
clawdi agent projects add-context atlas --project engineering --priority 10
clawdi vault resolve OPENAI_API_KEY --agent atlas --debug
```

## JSON Contracts

- Keep machine-readable statuses for automation:
  - `binding_target_ambiguous`
  - `vault_conflicts_blocked`
  - `accepted_membership_pending_binding`

## Web Changes (Proposed)

1. Rename primary navigation and labels from legacy terminology to
   project-centric wording.
2. Project detail page includes sharing lifecycle surfaces:
   links, invitations, members, revoke/remove/unshare.
3. Inbox acceptance confirms project access and next-step bind options.
4. Agent detail page includes:
   primary project selector,
   context project list with priority order,
   conflict policy controls.
5. Vault debug panel shows provenance chain at agent boundary.

## Migration Notes from Current Naming

This section is intentionally explicit so implementation PRs can migrate
terminology without ambiguity.

## Naming Migration Rules

1. Use `Project` as the only user-facing data boundary term.
2. Use `project access + agent binding` for collaboration + runtime composition.
3. Use `context project binding` for read-only/runtime supplemental projects.
4. Keep legacy graph terminology out of user-facing docs and UI copy.

## Data/Behavior Migration Strategy

1. Keep existing stored relationships functional during transition with
   compatibility shims.
2. Map each existing share relationship to project membership.
3. Map each existing composition edge to an agent context binding.
4. Derive one primary project per agent from current default write
   behavior.
5. Create a Personal/Home project only when needed as fallback for
   users lacking a suitable existing project.
6. Maintain backwards-compatible read endpoints during rollout with
   deprecation headers.

## Security Model

1. Authorization checks:
   project membership gates project access; agent ownership gates binding
   edits.
2. Write restrictions:
   default writes to primary project; explicit writes require role
   permission.
3. Read restrictions:
   context project data is readable only through explicit binding.
4. Revocation guarantees:
   removing member or unsharing removes downstream agent bindings created
   via that access unless policy marks them explicitly retained.
5. Auditability:
   log sharing, acceptance, binding edits, conflict overrides, and
   unshare actions.

## Implementation Phases

1. Phase 0: Docs and terminology lock
   - Land this design doc and scenario rewrite.
   - Freeze user-facing vocabulary to `Project + Agent`.
2. Phase 1: Schema and compatibility layer
   - Introduce project and agent binding entities.
   - Add compatibility mapping from existing legacy naming.
3. Phase 2: Sharing lifecycle endpoints
   - Links, invitations, inbox acceptance, members management, unshare.
4. Phase 3: Agent binding runtime
   - Primary/context binding APIs and CLI.
   - Vault resolution precedence and conflict blocking.
5. Phase 4: UI/CLI rename completion
   - Remove legacy labels and deprecated command aliases.
   - Keep migration diagnostics and docs references for one release.
6. Phase 5: Cleanup
   - Delete compatibility shims and stale wording from internal-only
     comments where safe.

## Open Questions

1. Should explicit conflict allow be one-time per command, or persisted
   per agent binding pair?
2. When project access is revoked, should the system hard-delete affected
   context bindings or soft-disable them for diagnostics?
3. Should primary project changes require a validation dry-run for vault
   conflict impact?
