# Scoped entities — design doc

**Status**: approved, ready for phase 1
**Authors**: dual review (Claude Code + Codex), 2 rounds
**Last update**: 2026-04-29

---

## TL;DR

- Introduce a first-class `Scope` entity. Skills, vaults, memories belong to a scope.
- Each `agent_environment` has its own `default_scope_id` (env-local scope, auto-created on env registration). Each user has one `Personal` scope (auto-created on signup, used for dashboard-created entities without an env context).
- **v1 daemon ships skill bidirectional sync, but every env has its own scope by default — no cross-machine skill propagation in v1.** A user who installs a skill on Machine A does not see it on Machine B. The bidirectional sync surface (the 11 rounds of review behind us) operates within a scope, never across.
- Sharing across users / cross-machine "join scope" workflow is **documented in this doc as future work** and is not in v1's deliverable.

---

## Problem

Today every `Skill` row is keyed by `(user_id, skill_key)`. Every `clawdi serve` daemon — across every machine, every agent — reads and writes the same row. That gives the killer demo (edit on laptop, appears on desktop) but also creates the conflict surface that drove 11 rounds of dual review.

For v1 we want the bidirectional cross-machine path to be **opt-in**, not the default. Single-machine users (the 99% case during launch) get a clean local-edits + dashboard-edits-with-conflict-resolve experience. Multi-machine users default to isolation; sharing is an explicit action they take when they're ready.

This pivot also generalizes: memories, vault items, and possibly session ranges all benefit from the same grouping primitive. Doing the abstraction once for skills sets up the rest of the data plane to follow.

## Goals

1. **Per-machine isolation by default**. New machine = new scope. Skills uploaded by Machine A are invisible to Machine B unless a user explicitly joins them.
2. **First-class Scope** entity that other models reference. Future memory/vault/session scoping reuses the same primitive.
3. **No cross-user sharing in v1**, but the schema preserves the door (single-owner today, `ScopeMembership` table is a clean future addition without table migration).
4. **Reversible launch**. Migration is forward-only on schema, but daemon behavior is governed by which scope a row belongs to — a config-only revert is feasible.

## Non-goals (v1)

- **Cross-machine skill sync UX**. No "join my Atlas scope" dashboard flow, no bulk copy-skills-between-scopes operation. Scope on Env is set at registration and stays put unless a future PR ships the workflow.
- **Cross-user sharing** (ScopeMembership, invitation, roles, audit log).
- **Vault encryption rework for shared scopes** (per-member envelope encryption is a separate cryptography milestone).
- **Memory / Vault scoping migration**. Phase 1 adds `scope_id` columns where needed for the schema to be coherent, but only `Skill` enforces / queries by it. Memory and Vault catch up in later phases.
- **API path scheme overhaul**. Phase 1 keeps existing `/api/skills/...` paths but adds the route shim that resolves scope server-side. New `/api/scopes/{scope_id}/...` shape ships in phase 2.

## Schema (final, locked)

```sql
CREATE TABLE scopes (
  id                     UUID PRIMARY KEY,
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  slug                   TEXT NOT NULL,
  kind                   TEXT NOT NULL
                           CHECK (kind IN ('personal', 'environment')),
  origin_environment_id  UUID NULL REFERENCES agent_environments(id) ON DELETE SET NULL,
  description            TEXT NULL,
  archived_at            TIMESTAMPTZ NULL,
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, slug)
);

-- Exactly one personal-kind scope per user. Future shared kinds
-- have no such restriction.
CREATE UNIQUE INDEX scopes_one_personal_per_user
  ON scopes (user_id) WHERE kind = 'personal';

ALTER TABLE agent_environments
  ADD COLUMN default_scope_id UUID NOT NULL REFERENCES scopes(id);

-- Skills today have NO unique constraint on (user_id, skill_key) —
-- the existing schema relies on advisory_lock + select-then-write
-- for serialization. Phase 1 adds the new invariant as a PARTIAL
-- unique index covering only active rows: soft-deleted rows
-- (is_active = false) keep their original skill_key without
-- blocking new uploads. This matches what every existing query
-- already filters on.
ALTER TABLE skills
  ADD COLUMN scope_id UUID NOT NULL REFERENCES scopes(id);

-- SQLAlchemy / Alembic form (preferred — autogen friendly):
--   Index(
--       'skills_active_user_scope_skill_key_key',
--       'user_id', 'scope_id', 'skill_key',
--       unique=True,
--       postgresql_where=text('is_active = true'),
--   )
-- Equivalent emitted DDL:
CREATE UNIQUE INDEX skills_active_user_scope_skill_key_key
  ON skills (user_id, scope_id, skill_key) WHERE is_active = true;

ALTER TABLE skill_conflicts
  ADD COLUMN scope_id UUID NOT NULL REFERENCES scopes(id);

ALTER TABLE vaults
  ADD COLUMN scope_id UUID NOT NULL REFERENCES scopes(id);
```

Notes on each decision:

- **`user_id` stays on every row** as the multi-tenant boundary. Defense in depth — every read filters by `user_id` even after `scope_id` is in place.
- **No `is_default` flag on `Scope`.** Daemon defaults live on `agent_environments.default_scope_id`. Personal-scope lookup is `WHERE user_id = $me AND kind = 'personal'` (one-row partial unique index is the actual invariant).
- **`Vault.scope_id`, not `VaultItem.scope_id`.** Items inherit scope from the parent vault; avoids the "item says A, vault says B" invalid state. v1 constraint: a vault and all its items live in one scope. Per-secret cross-scope sharing is a separate future feature, not this PR.
- **`kind` is a CHECK constraint, not an ENUM.** `'shared'` (and possibly `'workspace'` later) will be added by dropping and re-adding the constraint — easier to evolve than `ALTER TYPE` on Postgres.
- **`origin_environment_id` is `ON DELETE SET NULL`.** Deleting an env doesn't destroy its env-local scope; the scope orphans and stays available so the user doesn't lose history. Future "archive scope" UX cleans them up.
- **`slug` is user-supplied + auto-fallback on collision.** API path uses `scope_id` UUID (stable forever). Slug is mutable display metadata only.

## Migration plan (single Alembic up())

The migration is **idempotent** — every step is guarded so a crash mid-run is restartable. Use a slug derived from `(env.id, env.agent_type)` for env-local scopes so re-runs hit the same row.

```
 1. CREATE TABLE scopes (columns, CHECK constraint, UNIQUE(user_id, slug))
 2. CREATE UNIQUE INDEX scopes_one_personal_per_user
      ON scopes (user_id) WHERE kind = 'personal'
 3. ADD nullable columns:
      agent_environments.default_scope_id,
      skills.scope_id,
      skill_conflicts.scope_id,
      vaults.scope_id
 4. Cleanup: detect and resolve any (user_id, skill_key) duplicates.
    Strategy: keep the row with most-recent `updated_at`; soft-delete
    others (is_active = false). Log every duplicate set so the team
    can audit. Refuses to proceed if more than `SCOPE_MIGRATION_DUP_THRESHOLD_PCT`
    (env var, default 1) of skills are affected — operator can raise
    the threshold per `--db-revision` if a one-off cleanup needs it
    without editing the migration file.
 5. INSERT INTO scopes (id, user_id, name, slug, kind, ...)
    SELECT ... 'personal' for every user
    ON CONFLICT DO NOTHING  -- partial unique index covers it
 6. INSERT INTO scopes (id, user_id, name, slug, kind, origin_environment_id, ...)
    SELECT ... env-local for every agent_environment
    -- slug derived: f"env-{env.id.hex[:12]}" — guaranteed unique per
    -- env, never collides between envs of the same user
    ON CONFLICT (user_id, slug) DO NOTHING
 7. UPDATE agent_environments
      SET default_scope_id = (SELECT id FROM scopes WHERE origin_environment_id = agent_environments.id)
      WHERE default_scope_id IS NULL
 8. Move existing skill tarballs in file_store from old path
    `skills/{user_id}/{skill_key}.tar.gz` to scoped path
    `skills/{user_id}/{scope_id}/{skill_key}.tar.gz`. Migration:
    a. Compute target scope_id per skill (heuristic in next section).
    b. file_store.copy(old, new) — does NOT delete old path until
       all skills in this user's batch confirm.
    c. UPDATE skills SET file_key = new_path WHERE id = ...
    d. After commit: delete old paths in a separate cleanup pass
       (deferred to next migration / one-off script — keeps this
       migration's blast radius bounded).
 9. UPDATE skills SET scope_id = ${heuristic per row}
    WHERE scope_id IS NULL
10. UPDATE skill_conflicts
      SET scope_id = (SELECT default_scope_id FROM agent_environments
                      WHERE id = skill_conflicts.agent_environment_id)
      WHERE scope_id IS NULL
    -- conflicts with NULL agent_environment_id (legacy) → user's personal
11. UPDATE vaults SET scope_id = (user's personal scope)
    WHERE scope_id IS NULL
12. ALTER TABLE ... ADD FK NOT VALID  (avoids ACCESS EXCLUSIVE lock)
13. ALTER TABLE ... VALIDATE CONSTRAINT  (row-level only)
14. assert no NULLs remain via SELECT count(*) WHERE x IS NULL
15. ALTER COLUMN ... SET NOT NULL
16. op.create_index(
      'skills_active_user_scope_skill_key_key',
      'skills',
      ['user_id', 'scope_id', 'skill_key'],
      unique=True,
      postgresql_where=sa.text('is_active = true'),
    )
    -- Alembic Python form. Equivalent DDL:
    --   CREATE UNIQUE INDEX … WHERE is_active = true
    -- Partial index — step 4 soft-deleted duplicates remain in
    -- the table for audit; only is_active=true rows compete for
    -- the unique slot.
```

### Scope-aware file storage path

Today: `_file_key(user_id, skill_key)` → `skills/{user_id}/{skill_key}.tar.gz`.

Phase 1: `_file_key(user_id, scope_id, skill_key)` → `skills/{user_id}/{scope_id}/{skill_key}.tar.gz`.

Without this, two scopes with the same skill_key would clobber each other in object storage on the next upload. Required in phase 1, not deferable.

### Scope-aware advisory lock

Today: `_advisory_lock_key(user_id, skill_key)`.

Phase 1: `_advisory_lock_key(user_id, scope_id, skill_key)`.

Same reason as the file path: the lock must serialize on the same identity the unique constraint enforces. Required in phase 1.

### SSE channel scoping

Today's SSE channel is **per-user**, not env-aware. Every connected daemon for a user receives every skill event. (My earlier draft incorrectly said it was env-aware — it isn't.)

Phase 1 mitigation: server adds a `scope_id` field to every SSE event payload (additive — new field, no existing field touched). Daemon drops any event whose `scope_id` doesn't match its env's `default_scope_id`. Both ends change, but each change is small: server is a one-line additive payload field; daemon is one conditional in the event handler.

Phase 2: server-side filter so daemons subscribe to a specific scope channel and irrelevant events never traverse the wire.

This means phase 1 trades a small amount of network noise for a simpler server change. Acceptable.

### Skill backfill heuristic

For each existing skill row:
- **User has 1 env**: skill goes into that env's local scope. Trivial.
- **User has multiple envs**: skill goes into the most recently active env's local scope. Ordering is deterministic: `ORDER BY last_seen_at DESC NULLS LAST, id DESC LIMIT 1`. Tiebreak by `id DESC` so the same migration on the same data picks the same env every time (re-runs idempotent).
- **User has 0 envs**: skill goes into the user's Personal scope. Edge case (skills uploaded but no env registered).

The same `ORDER BY last_seen_at DESC NULLS LAST, id DESC LIMIT 1` SQL is reused at runtime by the Clerk-JWT write path's auto-pick — the same heuristic for migration AND for live writes ensures users see consistent destinations across the cutover.

Multi-env users get a one-time dashboard banner post-migration explaining where their skills landed and that cross-machine sync is now an explicit setting that hasn't been enabled yet (with a "learn more" link to the future scope-sync docs).

### Vault backfill

All existing vaults go into the user's Personal scope. Vaults are not machine-bound today; Personal is the right default home.

## Phasing (concrete PR boundaries)

### Phase 1 — schema + migration + minimal route shim (this milestone)

- Alembic migration as above.
- New `app/models/scope.py`.
- `Skill`, `Vault`, `AgentEnvironment`, `SkillConflict` models gain `scope_id` / `default_scope_id` columns.
- `_file_key` and `_advisory_lock_key` accept `scope_id` and include it in the path / lock identity.
- **Env registration becomes scope-aware.** `POST /api/environments` (in `sessions.py`) creates the env's local scope inline and sets `default_scope_id` in the same transaction. Without this, the NOT NULL constraint can't be enforced for new envs.
- **Route shim handles compat carefully**:
  - **READ paths** (`GET /api/skills`, `GET /api/skills/{key}`, content-fetch): scope-**agnostic** for Clerk JWT auth — return all of the user's scopes' skills, decorated with `scope_id`. This preserves the dashboard's "I see all my skills" UX after backfill. For api_key auth, filter to the bound env's `default_scope_id` so daemons only get their own scope's data.
  - **WRITE paths** (`POST /upload`, `DELETE`, `POST /install`): resolve the target scope from caller context.
    - api_key → bound env's `default_scope_id` (always defined, no ambiguity).
    - Clerk JWT, single env → that env's `default_scope_id`.
    - Clerk JWT, multiple envs → use the **most recently active** env's `default_scope_id` (same heuristic as the backfill at migration time). No 400, no prompt. The dashboard isn't yet scope-aware, so a picker doesn't exist; auto-picking the most-active env keeps installs working without breaking the v1 UX. The phase 3 picker replaces this auto-pick.
    - Clerk JWT, zero envs → user's Personal scope (falls back gracefully — pre-daemon accounts).
  - **Conflict-resolve path**: writes inherit the conflict row's `scope_id`.
- **Minimal daemon change.** Daemon receives a new `scope_id` field on each SSE event payload and ignores any event whose `scope_id` doesn't match its env's `default_scope_id`. The payload change is **additive** — `scope_id` is a new field; no existing field is renamed, removed, or repurposed, so older daemon binaries that don't read it keep working. The daemon-side change is one conditional inside `sse-client.ts`'s event handler that drops mismatched events early. None of the 11-rounds-reviewed sync logic (queue, advisory-lock interaction, conflict-resolve flow, `_upsert_skill` invariants) is touched. Endpoint URLs unchanged. Phase 2 moves the filter server-side.
- **Minimal dashboard change**: one-time post-migration banner for multi-env users explaining where their skills landed and why cross-machine sharing now requires an explicit setting (with a link forward to the future scope-sync workflow). No new UI components, no scope picker, no scope filter.
  - **Banner trigger**: shown when the authenticated user has ≥2 envs AND `user_settings.scope_migration_banner_dismissed_at` is NULL.
  - **Dismiss state**: persisted server-side as a key in the existing `user_settings` JSONB column (`scope_migration_banner_dismissed_at: ISO timestamp`). Cross-device — once dismissed on one browser, doesn't reappear elsewhere. Backed by a simple `PATCH /api/user/settings` call on banner close.
  - **Why server-side, not localStorage**: dismissals stored in localStorage would re-trigger the banner on every fresh browser / incognito session, which is annoying noise long after the migration is irrelevant.
- **Kill switch**: `SCOPE_ROUTING_ENABLED` env var (default `true`). When `false`, routes ignore `scope_id` and behave like pre-migration (read all user's skills, write to whichever default scope is convenient). Lets ops disable scope routing without rolling back the migration if a regression surfaces post-deploy.
- Tests cover: scope creation invariants, partial-unique enforcement, migration backfill (skill heuristic, vault → personal, conflict via env), file_store path migration, route compat shim for both auth types, kill-switch behavior.

### Phase 2 — env-scoped routes + daemon awareness

- New `/api/scopes/{scope_id}/skills/...` routes alongside old ones.
- Daemon reads `agent_environments.default_scope_id` at boot via existing env endpoint, sends new-shape requests.
- Old `/api/skills/...` paths return a deprecation header but keep working for two weeks, then 410.
- Conflict UI scoped to specific scope.
- Sessions / Memory still pre-scoped (added in phase 4 if not earlier).

### Phase 3 — dashboard scope awareness

- Skill list shows scope badge ("MacBook" / "Personal" / etc).
- Skill detail page shows which scope owns it.
- Marketplace install flow asks which scope to install into when there's no current env context (replaces the phase 1 auto-pick).
- (The post-migration banner already shipped in phase 1; phase 3 doesn't re-introduce it.)

### Phase 4 — Memory + Session scope enforcement (Vault columns already populated in phase 1)

- Phase 1 already added `scope_id` to `vaults` and backfilled to Personal. Phase 4 wires the read/write paths to actually filter and enforce that column.
- New: `Memory` and `Session` gain `scope_id` columns + backfill in their own follow-up migration (Memory → Personal, Session derives from `environment_id` → that env's `default_scope_id`).
- API filters across vault, memory, session honor scope.

### Future milestones (not scoped, design notes only)

#### Cross-machine scope sync

The whole point of having scope as a first-class entity is that two envs can point at the same scope and share its contents. v1 ships isolated; the workflow to combine them is a follow-up.

Sketch:
- Dashboard "Combine machines" flow: pick two envs, pick which scope to consolidate into (or create a new shared scope), choose which scope's skills win on collision.
- Backend operation: bulk move/copy skills between scopes; `agent_environments.default_scope_id` reassigned for both envs; daemons see the change on next env-info poll and re-reconcile.
- Conflict surface returns to roughly today's, but it's now scoped to the joined-scope membership and the user opted into it.
- Unjoin = reverse: split a scope back into per-env scopes (or move one env back out to its own scope).

This work depends on phase 1-3 landing cleanly first.

#### Cross-user sharing (ScopeMembership)

Adds a `scope_memberships (scope_id, user_id, role)` table. Tenancy filter shifts from `WHERE user_id = $me` to `WHERE user_id = $me OR scope_id IN (SELECT scope_id FROM scope_memberships WHERE user_id = $me AND role IN (...))`. Vault encryption story needs an envelope-encryption design (per-member encrypted vault key). UI gets invitation flow, roles, audit log.

Schema cost today to preserve this future: adding `kind = 'shared'` to the CHECK constraint requires `DROP CONSTRAINT ... ADD CONSTRAINT`. Trivial.

#### Public scopes (subscribe-only marketplace)

A scope can be marked `kind = 'shared_public'`, world-readable. Users subscribe to receive its skills, can't write back. Marketplace rebuilt on this primitive instead of GitHub-fetch + install.

Schema cost: another CHECK kind value. Subscription state lives in a new `scope_subscriptions (scope_id, user_id, ...)` table.

## Risk and rollback

- **Migration is forward-only**. Reverting the schema after data is in place is risky on a populated table. The kill switch (`SCOPE_ROUTING_ENABLED=false`) is the runtime safety valve — disables scope routing in routes without touching schema.
- **Day-1 dashboard / daemon divergence** (Codex's NOT-GO blocker, addressed): the route shim's READ paths return all of the user's scopes' skills for Clerk JWT auth, not just Personal. Without that, after backfill puts skills into env-local scopes, the dashboard would query Personal and silently see an empty list while the daemon's data lives in env-local — a real day-1 regression. Mitigated by READ-scope-agnostic routes for browser auth.
- **File-store tarball collision** (Codex's blocker, addressed): `_file_key` now includes `scope_id` so two scopes with the same `skill_key` don't overwrite each other's tar. Migration step 8 moves existing tarballs to scoped paths before the new constraint is enforced.
- **Daemon behavior is config-driven post-Phase-2**. If skill cross-machine bugs surface, the answer is to reassign `agent_environments.default_scope_id` and re-converge, not to roll back schema.
- **Two-env users may be confused** post-migration when their skills no longer "appear on the other machine". Banner + docs link mitigates; this is a known UX cost of the safer default.
- **Backfill heuristic for multi-env skills is best-effort.** A user with two equally-active envs will see their skills land on whichever was more recently active. Acknowledged in the banner; the future cross-machine sync workflow is the proper fix.
- **Duplicate `(user_id, skill_key)` rows pre-migration** (no DB constraint exists today, only advisory lock + select-write enforces uniqueness in practice): step 4 of the migration cleans them up by keeping the most-recently-updated row and soft-deleting the others. Refuses to proceed if more than 1% of skills are affected — that signals deeper data drift that needs ops attention before the migration runs.

## Open questions (resolved)

- ~~Path naming `/api/agents/{env_id}/...` vs `/api/scopes/{scope_id}/...`?~~ → `/api/scopes/{scope_id}/...` (phase 2). `/api/agents/{env_id}/...` stays for env-runtime concerns (heartbeat, registration, env info).
- ~~Default for marketplace install?~~ → api_key (CLI / daemon): bound env's `default_scope_id`. Clerk JWT (dashboard): single env → that env's default scope. Multi env → most-recently-active env's default scope (auto-pick, matches backfill heuristic; v1 dashboard isn't scope-aware so a picker doesn't exist yet). Zero envs → Personal scope (pre-daemon account fallback). Phase 3 dashboard adds an explicit scope picker, replacing the auto-pick.
- ~~Old route deprecation window?~~ → Two weeks after phase 2 ships, then 410.
- ~~Vault collapse into Scope?~~ → No. Vault stays its own concept; `Vault.scope_id` is the integration point.
- ~~`Scope.is_default` flag?~~ → No flag. Personal-scope lookup uses `kind = 'personal'` + partial unique index.
- ~~Vault.scope_id vs VaultItem.scope_id?~~ → Vault.
- ~~`kind` enforcement?~~ → CHECK constraint with literal list.
- ~~Slug semantics?~~ → User-supplied, auto-fallback on collision, mutable display only (API uses `scope_id` UUID).
- ~~Reassigning env.default_scope_id moves existing skills?~~ → No. Existing skills stay in their original scope. "Move/copy skills between scopes" is a separate explicit operation in a future phase.

## Open questions (remaining for phase 2/3)

- Banner copy for the post-migration dashboard message — needs product polish, not a blocker for phase 1.
- Whether the marketplace install dropdown shows all user scopes or just envs (matters when phase 3 ships).
- Whether `scope.archived_at` triggers `scope_id IS NULL` reassignment for child entities or refuses delete — picked when archive UX is designed.

## Decision needed

**Approve phase 1?** Phase 1 is mostly data layer: migration + new `Scope` model + scope_id columns on Skill / Vault / SkillConflict / AgentEnvironment + scope-aware `_file_key` and `_advisory_lock_key` + a server-side route shim that resolves caller scope. The only user-visible surface is a one-time post-migration banner for multi-env users (dismissable, persisted in `user_settings`). The daemon gains a single SSE-event filter conditional. No new dashboard UI components; the scope picker, scope filter, and "Combine machines" workflow all wait for phase 3+. Reversible at runtime via `SCOPE_ROUTING_ENABLED=false` without rolling back the migration.
