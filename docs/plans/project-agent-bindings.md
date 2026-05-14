# Project + Agent Bindings Design

**Status:** draft for PR #88 pre-implementation alignment  
**Last updated:** 2026-05-14  
**Owner:** product + platform

## Summary

This document replaces legacy graph-era terminology with a simpler model:

- `Project` is the collaboration and data ownership boundary.
- `Agent` is the runtime boundary that reads from one or more projects.
- Every Agent has exactly one Home Project and zero or more attached
  Projects.
- Local project-folder links are CLI-only selection helpers for
  `clawdi run`; they do not compose Projects or change which Projects an
  Agent uses.

Project composition is not project-to-project. Composition happens only
when an agent runs.

## Goals

1. Use `Project + Agent` as the only user-facing model.
2. Remove legacy boundary terminology from product and docs.
3. Ensure each Agent has one Home Project for default reads/writes.
4. Support one Agent using multiple Projects in v1:
   one Home Project plus zero or more attached Projects.
5. Keep sharing and membership independent from Agent use:
   accepting a shared Project grants access, then users explicitly
   attach that Project to Agents when needed.
6. Keep local CLI folder links separate from the cloud Project model:
   they only help the operator choose a Project from the current folder.
7. Keep default write behavior deterministic:
   writes go to the Agent Home Project unless explicitly overridden.
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
5. No test implementation changes in this planning step.
6. No backend/CLI/web runtime implementation in this planning step.

## User Model

## Core Objects

- `Project`
  - Contains skills, vault metadata/content, and future memory/session
    data.
  - Is owned by one account and may be shared with other accounts.
  - May be a Personal/Home Project, but it is still a normal Project.
- `Agent`
  - Represents one runnable assistant identity or environment endpoint.
  - Has one Home Project and ordered attached Projects that define its
    read/write boundary.
- `Agent Project Use`
  - Exactly one Project is the user-facing Home Project.
  - Zero or more Projects are user-facing attached Projects.
  - Attached Projects have explicit order.
  - Internal API/JSON names may still use `primary`, `context`, and
    `priority` during compatibility rollout.
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
- Home Project answers: "Where do default writes go?"
- Attached Project order answers: "Which extra Projects are read first?"
- Folder link answers: "When I run from this local folder, which
  Project should the CLI use for vault env injection?"

## Data Model Proposal

The names below are proposed storage/API names. User-facing surfaces use
Home Project, attached Project, and order, with compatibility layers for
existing internal names where needed.

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

1. One Home Project binding per agent:
   unique partial index on `agent_id` where `binding_type='primary'`.
2. No duplicate Project attachment for the same Agent:
   unique on `(agent_id, project_id)`.
3. Attached Project order uniqueness:
   unique on `(agent_id, binding_type, priority)`.
4. Home Project must be writable by Agent owner (owner/editor
   membership).
5. Attached Project may be read-only (`viewer`) and must never be default
   write target.
6. No project-to-project edges in schema.

## Runtime and Vault Resolution Rules

## Binding Boundary

- Runtime composition is computed at agent boundary only.
- Effective read set = Home Project + ordered attached Projects.
- Effective default write target = Home Project only.

## Resolution Order

1. Home Project first.
2. Attached Projects in explicit order.
3. If key appears in multiple attached Projects at the same order, treat
   as conflict.

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

- Unqualified writes go to the Home Project.
- Writes to attached Projects require explicit target and write role.
- Viewer-shared attached Projects are read-only by default.

## CLI Vault Env Selection

`clawdi run` can select a Project for vault env injection without
changing Project membership or Agent bindings:

1. `clawdi run --project <project> -- <cmd>` uses the explicit Project.
2. Without `--project`, `clawdi run -- <cmd>` may use a linked folder's
   Project when the current folder or a parent folder has a local link.
3. `clawdi run --no-project-folder -- <cmd>` skips linked-folder lookup.
4. If no Project is selected by flag or folder link, the command keeps
   the existing default vault resolution behavior.

Folder links are local operator convenience only. They are not stored as
cloud Project composition and do not affect which Projects an Agent has
as Home or attached Projects.

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
   - Design implication: Hermes needs an explicit Clawdi-side binding or
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
- Store Clawdi Project membership plus each Agent's Home Project and
  attached Projects in the cloud model. Use native project adapters only
  to choose or label local data, never to create cross-Project
  composition.
- For `clawdi run`, preserve the selection order:
  explicit `--project`, then local folder link, then existing default
  behavior. Agent-native project hints may improve UX suggestions, but
  must not silently attach Projects to Agents.

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

Accept responses return membership state and Agent-use suggestion status,
but do not attach the Project to any Agent unless requested with explicit
agent ids.

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
3. `clawdi agent projects ...` for setting the Home Project and attached
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
clawdi agent projects set-home atlas --project personal
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
  - `binding_target_ambiguous`
  - `vault_conflicts_blocked`
  - `accepted_membership_pending_binding`

## Web Changes (Proposed)

1. Rename navigation and labels from legacy terminology to
   project-centric wording.
2. Project detail page includes sharing lifecycle surfaces:
   links, invitations, members, revoke/remove/unshare.
3. Inbox acceptance confirms project access and next-step bind options.
4. Agent detail page includes:
   Home Project selector,
   attached Project list with explicit order,
   conflict policy controls.
5. Vault debug panel shows provenance chain at agent boundary.

## Migration Notes from Current Naming

This section is intentionally explicit so implementation PRs can migrate
terminology without ambiguity.

## Naming Migration Rules

1. Use `Project` as the only user-facing data boundary term.
2. Use `Project access + Agent use` for collaboration + runtime composition.
3. Use `Home Project` for the default-write Project.
4. Use `attached Project` and `order` for additional Agent read sources.
5. Keep `primary`, `context`, and `priority` in API/JSON/backcompat internals only.
6. Keep legacy graph terminology out of user-facing docs and UI copy.

## Data/Behavior Migration Strategy

1. Keep existing stored relationships functional during transition with
   compatibility shims.
2. Map each existing share relationship to project membership.
3. Map each existing composition edge to an Agent attached Project.
4. Derive one Home Project per Agent from current default write
   behavior.
5. Create a Personal/Home Project only when needed as fallback for
   users lacking a suitable existing project.
6. Maintain backwards-compatible read endpoints during rollout with
   deprecation headers.

## Security Model

1. Authorization checks:
   project membership gates project access; agent ownership gates binding
   edits.
2. Write restrictions:
   default writes to the Home Project; explicit writes require role
   permission.
3. Read restrictions:
   attached Project data is readable only through explicit Agent use.
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
   - Home/attached Project CLI backed by primary/context APIs.
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
2. When Project access is revoked, should the system hard-delete affected
   attached Projects or soft-disable them for diagnostics?
3. Should Home Project changes require a validation dry-run for vault
   conflict impact?
