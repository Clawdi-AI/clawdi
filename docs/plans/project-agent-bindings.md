# Project + Agent Project Design

**Status:** CLI/backend ship-state for PR #88; web surfaces are split out
**Last updated:** 2026-05-16
**Owner:** product + platform

## Summary

This document defines the shipped Project + Agent Project model:

- `Project` is the collaboration and data ownership boundary.
- `Agent` is the runtime boundary that reads from one or more Projects.
- Every Agent has one fixed Agent Project and zero or more attachments.
- Local project-folder links are CLI-only selection helpers for
  `clawdi run`; they do not compose Projects or change which Projects an
  Agent uses.

Project composition is not project-to-project. Composition happens only
when an agent runs.

## Goals

1. Use `Project + Agent` as the only user-facing model.
2. Keep old boundary terminology out of product and docs.
3. Ensure each Agent has one fixed Agent Project for default reads/writes.
4. Support one Agent using multiple Projects in v1:
   one Agent Project plus zero or more attached Projects.
5. Keep sharing and membership independent from Agent use:
   accepting a shared Project grants access, then users explicitly
   attach that Project to Agents when needed.
6. Keep local CLI folder links separate from the cloud Project model:
   they only help the operator choose a Project from the current folder.
7. Keep default write behavior deterministic:
   writes go to the Agent Project unless explicitly overridden.
8. Enforce safe multi-project vault resolution with provenance and
   explicit conflict handling.
9. Preserve validated PR #88 flows:
   links, invitations, inbox, member management, revoke/remove/unshare,
   vault conflict safety, and agent setup JSON.

## Non-goals

1. No nested project composition. Projects do not include projects.
2. No implicit write fan-out across multiple projects.
3. No automatic conflict override during vault/key collisions.
4. No cloud Project composition through local folder links.
5. No editor role in v1. Shared recipients are viewer-only.
6. No dashboard implementation in this PR. Web surfaces consume the same
   API contracts in a separate PR.

## Core Objects

- `Project`
  - Contains skills, vault metadata/content, and future memory/session
    data.
  - Is owned by one account and may be shared with other accounts.
  - May be a Personal, Agent, or user-created Project.
- `Agent`
  - Represents one runnable assistant identity or agent endpoint.
  - Has one fixed Agent Project and ordered attachments.
- `Agent Project Use`
  - Exactly one Project is the user-facing Agent Project.
  - The Agent Project is fixed to that Agent.
  - Zero or more Projects are user-facing attachments.
  - Attachments have explicit order.
  - Internal API/JSON names use `primary`, `context`, and `priority`.
- `Project Folder Link`
  - Local CLI configuration that maps a filesystem folder to a visible
    Project for operator convenience.
  - Used by `clawdi run` for vault env injection when no explicit
    Project is passed.
  - Does not grant access, create membership, attach a Project to an
    Agent, or compose cloud Projects.

## Mental Model

- Sharing answers: "Who can access this Project?"
- Agent Project use answers: "Which Projects can this Agent use at runtime?"
- Agent Project answers: "Where do default writes go?"
- Attachment order answers: "Which extra Projects are read first?"
- Folder link answers: "When I run from this local folder, which
  Project should the CLI use for vault env injection?"

## Data Model

The names below are the shipped storage/API names. User-facing surfaces
use Agent Project, attached Project, and order.

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
   - `role` (`viewer` in v1)
   - `joined_via` (`invite`, `link`)
   - `joined_at`
   - `resolved_owner_handle`
3. `project_share_links`
   - `id`
   - `project_id`
   - `token_hash`
   - `token_prefix`
   - `created_by_user_id`
   - `expires_at`, `revoked_at`
   - `redeem_count`, `last_redeemed_at`
4. `project_invitations`
   - `id`
   - `project_id`
   - `email`
   - v1 role is implicitly viewer
   - `invited_by_user_id`
   - `resolved_owner_handle`
5. `agents`
   - Internally backed by `agent_environments`
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

1. One internal Agent Project row per Agent:
   unique partial index on `agent_id` where `binding_type='primary'`.
2. No duplicate Project attachment for the same Agent:
   unique on `(agent_id, project_id)`.
3. Attached Project order uniqueness:
   unique on `(agent_id, binding_type, priority)`.
4. The internal primary row must point at the Agent's own
   `default_project_id`; users cannot switch it to another Project.
5. Attached Project may be read-only (`viewer`) and must never be default
   write target.
6. No project-to-project edges in schema.

## Runtime and Vault Resolution Rules

## Agent Use Boundary

- Runtime composition is computed at agent boundary only.
- Reads = Agent Project + ordered attachments.
- Default writes = Agent Project only.

## Resolution Order

1. Agent Project first.
2. Attached Projects in explicit order.
3. If a key appears in more than one Project in the Agent order, treat it
   as a conflict unless the caller explicitly allows first-match wins.

## Conflict Handling

- Default behavior: block on conflict and return structured error.
- Explicit override path: caller may pass an allow flag.
- Debug and conflict responses include provenance:
  - winning project id/name
  - skipped candidates
  - reason (`precedence`, `role_read_only`, `conflict_blocked`)
- Debug mode must expose full candidate chain without exposing secret
  values in logs by default.

## Write Rules

- Unqualified writes go to the Agent Project.
- Writes to attached Projects require explicit target and write role.
- Viewer-shared attached Projects are read-only by default.

## CLI Vault Env Selection

`clawdi run` can select a Project for vault env injection without
changing Project membership or Agent Project use:

1. `clawdi run --project <project> -- <cmd>` uses the explicit Project.
2. Without `--project`, `clawdi run -- <cmd>` may use a linked folder's
   Project when the current folder or a parent folder has a local link.
3. `clawdi run --no-project-folder -- <cmd>` skips linked-folder lookup.
4. If no Project is selected by flag or folder link, the command keeps
   the existing default vault resolution behavior.

Folder links are local operator convenience only. They are not stored as
cloud Project composition and do not affect which Projects an Agent has
as its Agent Project or attached Projects.

## Agent-Native Project Adapter Direction

The Clawdi cloud `Project` model must not assume every local agent uses
one identical project primitive. Each agent adapter should translate the
agent's native locality model into Clawdi's Project/Agent vocabulary.

Current adapter research from `packages/cli/src/adapters/*`:

1. Claude Code
   - Native locality: `~/.claude/projects/<encoded-absolute-path>/` plus
     per-entry `cwd` in JSONL.
   - Current adapter behavior: `collectSessions({ projectFilter })`
     prefilters encoded project directories, then verifies the real `cwd`.
   - Design implication: Claude Code can map local filesystem folders to
     Project selection with high confidence; folder ancestry is meaningful.
2. Codex
   - Native locality: `~/.codex/sessions/YYYY/MM/DD/*.jsonl` with
     `session_meta.payload.cwd` inside each file.
   - Current adapter behavior: full session walk, then filters by stored
     `cwd` when `projectFilter` is passed.
   - Design implication: Codex has no stable project directory index, so
     Project matching is content-derived from session metadata.
3. OpenClaw
   - Native locality: `OPENCLAW_STATE_DIR` or an OpenClaw home with
     `agents/<id>/sessions/sessions.json`; each entry may include
     `acp.cwd` and OpenClaw may host multiple native agents in one state
     root.
   - Current adapter behavior: enumerates all `agents/<id>` directories
     unless `OPENCLAW_AGENT_ID` narrows it, and filters by `acp.cwd`.
   - Design implication: Clawdi's Agent boundary must map to OpenClaw's
     native agent id as well as cwd; Project selection alone is not enough.
4. Hermes
   - Native locality: one SQLite `state.db`; session rows have `source`
     as a channel/origin tag, not a filesystem cwd.
   - Current adapter behavior: ignores `projectFilter` and reports
     `projectPath: null`.
   - Design implication: Hermes needs an explicit Clawdi-side attachment or
     operator-selected Project; native session storage cannot infer a
     folder Project.

Implementation direction:

- Keep `AgentAdapter` responsible for agent storage formats: detecting
  installs, collecting sessions, collecting skills, and writing skills.
- Add a narrower project-locality layer instead of overloading cloud
  Project semantics into every adapter:
  - `getNativeProjectHints()` for inspectable native folders/ids when an
    agent exposes them.
  - `matchNativeProject(path)` for cwd-based agents such as Claude Code,
    Codex, and OpenClaw.
  - `supportsProjectFilter` or equivalent capability metadata so Hermes
    and future non-filesystem agents can explicitly say "no native cwd".
- Store Clawdi Project membership plus each Agent's immutable Agent Project and
  attached Projects in the cloud model. Use native project adapters only
  to choose or label local data, never to create cross-Project
  composition.
- For `clawdi run`, preserve the selection order:
  explicit `--project`, then local folder link, then existing default
  behavior. Agent-native project hints may improve UX suggestions, but
  must not silently attach Projects to Agents.

## API Surface

## Projects and Sharing

1. `GET /api/projects/default`
2. `POST /api/projects`
3. `GET /api/projects`
4. `GET /api/projects/{project_id}`
5. `POST /api/projects/{project_id}/share-links`
6. `GET /api/projects/{project_id}/share-links`
7. `DELETE /api/projects/{project_id}/share-links/{link_id}`
8. `POST /api/projects/{project_id}/invitations`
9. `GET /api/projects/{project_id}/invitations`
10. `DELETE /api/projects/{project_id}/invitations/{invitation_id}`
11. `GET /api/projects/{project_id}/members`
12. `DELETE /api/projects/{project_id}/members/{member_user_id}`
13. `POST /api/projects/{project_id}/leave`
14. `POST /api/projects/{project_id}/unshare`

## Inbox / Accept

1. `GET /api/share/{token}/preview`
2. `POST /api/share/{token}/redeem`
3. `POST /api/share/{token}/upgrade`
4. `GET /api/me/invitations`
5. `POST /api/me/invitations/{invitation_id}/accept`
6. `POST /api/me/invitations/{invitation_id}/decline`
Accept responses return membership state and Agent-use suggestion status,
but do not attach the Project to any Agent unless requested with explicit
agent ids.

## Agent Project APIs

1. `GET /api/agents/{agent_id}/project-bindings`
2. `POST /api/agents/{agent_id}/project-bindings/context`
3. `PATCH /api/agents/{agent_id}/project-bindings/context/reorder`
4. `DELETE /api/agents/{agent_id}/project-bindings/{binding_id}`

There is no endpoint for changing the Agent Project. It is fixed to the Agent's
own Project.

## Vault Resolve / Write

1. `POST /api/vault/resolve?key=<KEY>&project_id=<project_id>`
2. `POST /api/vault/resolve?key=<KEY>&agent_id=<agent_id>`
3. `POST /api/vault/resolve?agent_id=<agent_id>`
4. Existing `/api/vault` CRUD routes accept explicit `project_id`
   where needed and keep plaintext resolution CLI/API-key-only.

These endpoints enforce Agent Project composition and return provenance.

## CLI Surface

## Command Families

1. `clawdi project ...` for project lifecycle and sharing.
2. `clawdi inbox ...` for accepting links/invitations.
3. `clawdi agent projects ...` for viewing the Agent Project and managing attached
   Project order.
4. `clawdi project folder ...` for local folder-to-Project selection
   used by `clawdi run`.
5. `clawdi run ...` for vault env injection into local commands.
6. `clawdi vault ... --agent <agent>` for runtime resolution.

## Example Commands

```bash
clawdi project create "Engineering"
clawdi project share engineering --label "demo handoff"
clawdi inbox accept https://clawdi.ai/share/<token>
clawdi agent projects attach atlas --project engineering --order 10
clawdi vault resolve OPENAI_API_KEY --agent atlas --debug
clawdi project folder link --project engineering
clawdi project folder status
clawdi run -- npm run deploy
clawdi run --project @alice/engineering -- npm run deploy
clawdi run --no-project-folder -- python main.py
clawdi project folder unlink
```

## JSON Contracts

- Keep machine-readable statuses for automation:
  - `vault_conflicts_blocked`
  - `already_owner`
  - `display_name_required`
  - `already_invited`

## Deferred Web PR

The CLI/backend PR defines the API contracts and CLI behavior. Web
surfaces are intentionally split into a follow-up PR and should consume
the contracts below without changing the core Project model.

1. Rename navigation and labels from legacy terminology to
   project-centric wording.
2. Project detail page includes sharing lifecycle surfaces:
   links, invitations, members, revoke/remove/unshare.
3. Inbox acceptance confirms Project access and next-step attach options.
4. Agent detail page includes:
   read-only Agent Project,
   attached Project list with explicit order,
   conflict policy controls.
5. Vault debug panel shows provenance chain at agent boundary.

## Migration Notes from Current Naming

This section is intentionally explicit so implementation PRs can migrate
terminology without ambiguity.

## Naming Migration Rules

1. Use `Project` as the only user-facing data boundary term.
2. Use `Project access + Agent use` for collaboration + runtime composition.
3. Use `Agent Project` for the default-write Project.
4. Use `attached Project` and `order` for additional Agent read sources.
5. Keep `primary`, `context`, and `priority` in API/JSON internals only.
6. Keep old graph terminology out of user-facing docs and UI copy.

## Data/Behavior Migration Strategy

1. Map each existing share relationship to project membership.
2. Map each existing composition edge to an Agent attached Project.
3. Derive one Agent Project per Agent from current default write
   behavior.
4. Create a Personal Project only when needed as fallback for
   users lacking a suitable existing project.

## Security Model

1. Authorization checks:
   Project membership gates Project access; Agent ownership gates Agent Project
   edits.
2. Write restrictions:
   default writes to the Agent Project; explicit writes require role
   permission.
3. Read restrictions:
   attached Project data is readable only through explicit Agent use.
4. Revocation guarantees:
   removing member or unsharing removes downstream Agent attachments created
   via that access unless policy marks them explicitly retained.
5. Auditability:
   log sharing, acceptance, Agent attachment edits, conflict overrides, and
   unshare actions.

## Ship-State Checklist

1. Schema changes are in the PR migration.
2. Sharing lifecycle endpoints cover links, invitations, inbox
   acceptance, members, leave, and unshare.
3. Agent Project runtime covers fixed Agent Project, attached Projects,
   reorder, detach, stale attachment cleanup, and vault conflict safety.
4. CLI copy uses Project / Agent Project / attachment terminology.
5. Dashboard copy and dedicated pages stay in the split web PR.
6. Internal names such as `environment_id`, `binding_type`, `primary`,
   `context`, and `priority` remain implementation details.

## Follow-Up Questions

1. Should explicit conflict allow be one-time per command, or persisted
   per Agent attachment pair?
2. When should viewer-only Project sharing grow editor roles?
