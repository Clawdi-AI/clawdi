# Scope Mount — Sharing as Workspace Composition

> **Status:** Shipping spec. Replaces the v1 membership-rendering surface
> from [`2026-05-11-scope-sharing-design.md`](2026-05-11-scope-sharing-design.md).
> Underlying ScopeMembership infrastructure from v1 stays — it becomes
> the capability layer this spec composes ON TOP of.

---

## Summary

`accept` no longer just files Alice's scope under a "Shared with me"
section. It **mounts Alice's scope INTO one of your owned scopes**.
Your scopes become composable workspaces — your own content plus
mounted contributions from people who shared with you.

The membership table (v1) stays as the access-control primitive: it
answers *can the viewer see this source?*. The new mount table answers
*where does the viewer see it?* — composition lives at the scope layer,
not the user layer.

## Goals

- Make `accept` create a workspace mount, not just a permission grant.
- Enable team workspaces composed of multiple contributors' scopes.
- Enable vendor-published starter packs that auto-update across all
  users who mounted them.
- Preserve the v1 capability layer (membership) so safety properties
  (anonymous redeem, env-bound deploy-key blast radius, revocation)
  carry over unchanged.

## Non-goals (deferred)

- Editor role / shared writes (sharees stay read-only)
- Memory sharing
- Recursive mount-of-mount resolution (v2 ships shallow-only)
- Per-skill / per-vault-key `include_policy` filters (v3+)
- Marketplace / discovery of public scopes
- Revisiting auth model (Clerk JWT + unbound CLI api_key only)

## Mental model

Two layers, separated by purpose:

| Layer | Table | Question it answers | Lifecycle |
|-------|-------|---------------------|-----------|
| Capability | `ScopeMembership` (v1, unchanged) | "Can the viewer read scope X?" | Created by `accept`; bound to user × scope |
| Composition | `ScopeMount` (NEW) | "Where does scope X appear in the viewer's workspace?" | Created by `mount` (or implicit auto-mount on `accept`); bound to parent-scope × source-scope |

**Critical invariant:** mount edges are configuration on the PARENT
scope, not grants on the SOURCE. Mount resolution always re-checks
the viewer's independent membership in the source. If the viewer
re-shares the parent to a third party, that third party only sees
mount sources they have independent membership to — transitive
permission expansion is structurally impossible.

## Personas (recap from v1, unchanged)

- **Owner** — owns a scope, shares it.
- **Sharee (anonymous)** — has a URL, no account yet.
- **Sharee (registered)** — has a Clawdi account; receives invitation
  OR signs in after anonymous redeem.

## User journeys

### J1 — Owner generates a share link (unchanged from v1)

`clawdi scope share <scope> --label <text>` → URL printed once, hash
stored, frozen owner-handle stamped.

### J2 — Anonymous sharee accepts a link

`clawdi share accept <url>` from a logged-out terminal:
1. Server creates a `share_token` redemption row (v1 unchanged).
2. CLI stores raw token in `~/.clawdi/share-tokens.json`.
3. **NEW** — local config records a pending mount intent: "next time
   you log in, mount this source into your default-write scope as
   `@<owner-handle>/<source-slug>`".

### J3 — Anonymous sharee later logs in (upgrade path)

`clawdi share accept <same-url>` after `clawdi auth login`:
1. Server creates `ScopeMembership` (v1 unchanged — capability).
2. **NEW** — Server also creates `ScopeMount(parent=user_default_scope,
   source=alice_engineering, alias=@alice-handle/engineering)` if no
   mount for that pair already exists.
3. CLI eager-pulls skills under the mount's adapter path layout.

### J4 — Registered sharee accepts an email invitation

`clawdi scope invites --accept <id>` (or web dashboard click):
1. Server creates `ScopeMembership` (v1 unchanged).
2. **NEW** — Server creates `ScopeMount` into user's default-write scope.
3. CLI eager-pulls.

### J5 — Owner of mounted parent re-shares to a third party

Bob has `personal-bob` with mount → `alice-engineering`. Bob shares
`personal-bob` with Dave.

- Dave's `accept` creates `ScopeMembership(dave, personal-bob)`. Plus
  the mount auto-add for Dave into HIS default scope, pointing at
  `personal-bob`.
- When Dave reads skills "in" personal-bob, the resolver walks
  Bob's mount to alice-engineering. **It then checks** Dave has
  membership in alice-engineering. If he doesn't, alice-engineering's
  content is silently filtered out of Dave's view.
- Conclusion: Bob can re-share his composed workspace without granting
  Dave anything alice didn't authorize.

### J6 — Selective mount management (new)

```
clawdi scope mounts <my-scope>
clawdi scope mount <source> --into <parent> --alias <name>
clawdi scope unmount <source> --from <parent>
```

A user can mount the same source into multiple parents (different
aliases), or unmount without revoking the underlying membership.

### J7 — Vault key precedence (new)

`clawdi vault resolve OPENAI_KEY` against a composed scope:
1. Walk parent's own vault items first → match wins.
2. Otherwise walk mounts in `created_at ASC` order → first match wins.
3. CLI surfaces the WINNING source in the resolve output with
   `--debug` showing the full precedence chain.

## Data model

```sql
CREATE TABLE scope_mounts (
    id              UUID PRIMARY KEY,
    parent_scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    source_scope_id UUID NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    alias           VARCHAR(80) NOT NULL,
    mode            VARCHAR(20) NOT NULL DEFAULT 'live'
                    CHECK (mode IN ('live')),
                    -- snapshot_rev_N reserved for v3
    created_by      UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Same (parent, source) can only be mounted once.
    -- Updates to alias / mode go via UPDATE.
    UNIQUE (parent_scope_id, source_scope_id),

    -- Alias must be unique within a parent so the namespace is clean.
    UNIQUE (parent_scope_id, alias)
);

CREATE INDEX ix_scope_mounts_parent ON scope_mounts(parent_scope_id);
CREATE INDEX ix_scope_mounts_source ON scope_mounts(source_scope_id);
```

**Cascading deletes**: if either the parent or source scope is deleted,
the mount row goes with it. No orphan mounts.

**No `kind` column on mount** — Whether the source is Personal,
Environment, or hypothetically Team-kind is irrelevant to mount.
Mount only cares about parent + source as scope IDs.

## API surface

### NEW: ScopeMount management

```
POST   /api/scopes/{parent_scope_id}/mounts
       Body: { source_scope_id, alias?, mode? }
       Auth: require_user_auth_unbound + owner of parent_scope_id +
             viewer-or-owner of source_scope_id
       409 if mount already exists or alias collides.

GET    /api/scopes/{parent_scope_id}/mounts
       Lists active mounts on a scope (owner only).

DELETE /api/scopes/{parent_scope_id}/mounts/{mount_id}
       Owner-only. Membership to source NOT affected.
       (Use POST /api/me/scopes/{source}/leave to drop membership too.)
```

### CHANGED from v1: `accept` paths

`POST /api/share/{token}/upgrade` (logged-in share-link redemption):
- Same v1 behavior: creates `ScopeMembership` (unchanged).
- **NEW step**: also creates `ScopeMount(parent=resolve_default_write_
  scope(user), source=link.scope_id, alias=@<owner_handle>/<source_slug>)`
  in the SAME transaction, idempotent on conflict.
- Response shape extended with `mount_id`, `mount_alias`.

`POST /api/me/invitations/{id}/accept` (registered sharee accepts invite):
- Same: creates ScopeMembership (unchanged).
- **NEW step**: also creates ScopeMount, same logic.

`POST /api/share/{token}/redeem` (anonymous redemption):
- Unchanged. No mount yet (no parent scope exists for an anonymous
  CLI user). Mount happens on the eventual `share accept` after login.

### CHANGED from v1: read endpoints

`GET /api/skills`, `GET /api/vault`:
- Replace direct `scope_id_in_visible_set` filter with
  `scope_id_in_resolved_set` where the resolved set walks mounts:

  ```
  resolved_set = scope_ids_visible_to(auth).copy()
  for each scope_id in resolved_set:
      for each mount on parent=scope_id:
          if mount.source_scope_id in scope_ids_visible_to(auth):
              resolved_set.add(mount.source_scope_id)
  ```

- The `?scope_id=<parent>` query filter still works — it now matches
  rows in the parent OR in any mount it composes (subject to viewer
  membership in the source).

### REMOVED from v1's UX (capabilities still exist)

`GET /api/me/scopes/shared` (if it existed) — replaced by mount listing
under each owned scope. Membership rows still tracked server-side as
the capability layer; UX no longer surfaces them directly.

## CLI surface

### NEW commands

```bash
clawdi scope mounts <scope>            # list mounts under a scope
clawdi scope mount <source> \          # mount a scope I have membership in
       --into <parent>                 # into one of my owned scopes
       [--alias <name>]                # default = @<owner-handle>/<source-slug>
clawdi scope unmount <source> \
       --from <parent>                 # detach without revoking membership
```

### CHANGED: `share accept`

After `share accept <url>` (logged in):
- Old output: "Joined as viewer — your dashboard now lists this scope"
- New output: "Mounted '<scope>' from <owner> into your <parent>
  scope as @<owner-handle>/<source-slug>"

`--no-mount` flag added for users who want pure membership without the
auto-mount (rare; behaves like v1).

### CHANGED: `scope list`

```
$ clawdi scope list

My scopes (1):
  personal-bob            8f3a...  (personal)
    Personal
    └─ @alice/engineering  ← mount: 1 skill, 3 vault secrets
    └─ @carol/deploy        ← mount: 2 skills, 0 secrets

```

No more separate "Shared with me" section — mounts render nested under
their parent.

### CHANGED: `scope invites --accept`

Same as `share accept` — auto-mount into default-write scope. `--no-mount`
opt-out.

## Web surface

### CHANGED: InvitationsInbox accept handler

After `Accept`: toast says "Mounted into your Personal scope as
@alice/engineering" — no "Shared with me" section to direct user to.

### NEW: per-scope mounts panel

Each owned scope's detail page grows a "Mounted sources" section
showing:
- Source scope name + owner handle
- Mount alias
- Skill/vault count (lazy-fetched from source)
- "Unmount" button

### REMOVED: `/skills` "Shared with me" Alert banner

Mounted sources surface inline in the skill list (filtered by parent
scope picker) with a `@alice-handle/skill-name` prefix in the table.

## Skill on-disk layout

v1 used `<key>__<owner-handle>/` suffix. v2 keeps the same suffix —
it's an adapter-level concern unaffected by mount. The mount alias
only matters at the API / CLI listing layer; the daemon eager-pull
still writes to `getSharedSkillPath(key, owner_handle)`.

A future v3 could expose mount aliases in the adapter path for cleaner
multi-source overlay UX, but that's an opt-in adapter change, not a
mount-spec concern.

## Vault precedence (new in v2)

When a vault read targets a parent scope that has mounts:

```python
def resolve_vault_key(parent_scope_id, key, auth):
    # Parent's own keys win
    if hit := parent_vault.find(key):
        return (hit, source="own")
    # Walk mounts in created_at ASC order
    for mount in parent_mounts.order_by_created:
        if mount.source_scope_id in scope_ids_visible_to(auth):
            if hit := source_vault.find(key):
                return (hit, source=mount.alias)
    return None
```

CLI shows the winning source:
```
$ clawdi vault resolve OPENAI_KEY
sk-...  (from @alice/engineering)
```

With `--debug`:
```
$ clawdi vault resolve OPENAI_KEY --debug
sk-...  (from @alice/engineering)
  searched: personal-bob (not found)
            @alice/engineering ← match (mounted at created_at=2026-05-12T03:00Z)
            @carol/deploy (skipped — same key would have matched)
```

## Migration from v1 to v2

**v1 sharees keep their memberships unchanged.**

The migration script ALSO creates a `ScopeMount` row for each existing
ScopeMembership where the user has a default-write scope. Alias
collisions get a numeric suffix (`@alice/engineering-2`).

**v1 demo doc gets archived.** A new demo doc captures the v2 mount
flow with real CLI output. The historical v1 doc moves to
`docs/scenarios/archive/scope-sharing-demo-v1.md` so the codebase
records what the membership-only model looked like.

## Phasing (implementation plan summary)

See `docs/superpowers/plans/2026-05-12-scope-mount.md` for full task
breakdown.

| Phase | What lands | Risk gate |
|-------|------------|-----------|
| MA — Models + migration | `ScopeMount` table, no behavior change | Regress v1 visibility tests |
| MB — Mount endpoints | CRUD on mounts, owner-only | Cross-tenant 404 isolation |
| MC — Auto-mount on accept | `/upgrade` + invite-accept also mount | Idempotent on retry |
| MD — Resolution: skill + vault read paths walk mounts | The composition primitive activates | Existing v1 sharee read tests still pass + new mount tests pass |
| ME — CLI: `scope mount/unmount/mounts`, `accept` UX, `scope list` tree | User-visible v2 | Eager-pull still works post-accept |
| MF — Web: InvitationsInbox toast, scope detail mount panel, drop "Shared with me" | User-visible v2 on dashboard | Web build + manual smoke |
| MG — Migration script + demo doc rewrite | v1 sharees mounted into their default scopes; new demo captured | Backfilled mounts behave like fresh-redemption mounts |

## Hard questions resolved in this spec

1. **Pure replacement vs layered?** Layered. Membership stays as
   capability. Mount is the new composition primitive.

2. **Transitive sharing?** Impossible by construction — mount edges
   re-check viewer membership against source at every read.

3. **Anonymous redeem mount target?** Deferred until login. Mount
   only created during `/upgrade` (post-auth), not `/redeem`.

4. **Vault key collisions?** Parent-own wins; then mounts in
   `created_at` ASC order. Debug surfaces precedence.

5. **Write semantics?** Same as v1 — writes target the resolved scope
   (parent or explicit `--scope`), never silently into a mount source.
   To write to a mount source the user must `--scope <source-slug>`
   explicitly, which requires editor role (v3 feature).

6. **Recursive mount-of-mount?** Not in v2. Shallow only.

7. **Migration of v1 sharees?** One-time SQL fold: each existing
   ScopeMembership row spawns a corresponding ScopeMount into the
   user's default-write scope.

## Why codex-reviewed

Spawned an architectural-review session that confirmed:

- Membership is the right v1 primitive (not over-engineering)
- Mount IS a real abstraction win for composition use cases
- The two are at different layers, not competing
- Pure replacement of v1 is the wrong move — anonymous redeem +
  email invite both need a capability primitive that pre-exists
  any parent-scope choice
- Layered, additive, shallow-only, non-transitive is the safe shape

This spec encodes those recommendations.

## References

- v1 design (now historical): [`2026-05-11-scope-sharing-design.md`](2026-05-11-scope-sharing-design.md)
- v1 plan (executed): [`docs/superpowers/plans/2026-05-11-scope-sharing.md`](../plans/2026-05-11-scope-sharing.md)
- v2 plan: [`docs/superpowers/plans/2026-05-12-scope-mount.md`](../plans/2026-05-12-scope-mount.md)
- Live v1 demo (now historical):
  [`docs/scenarios/scope-sharing-demo.md`](../../scenarios/scope-sharing-demo.md)
