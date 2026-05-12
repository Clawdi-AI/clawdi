# Scope Composition (Mount) — v2 RFC

> A planning document, not a shipping spec. Captures the abstraction
> question the v1 sharing review surfaced and the path forward we agreed
> on with a second-opinion architectural review.

---

## TL;DR

**v1 (shipped):** `accept` creates a `ScopeMembership`. Sharing is a
permission grant — "Bob can read Alice's scope". Bob sees Alice's content
under a "Shared with me" section, distinct from his own scopes.

**v2 (this RFC):** Layer a `ScopeMount` table on top, allowing Bob to
*compose* Alice's scope (and others') into ONE of his own scopes. The
membership model stays unchanged — mount is the composition primitive,
membership remains the access-control primitive.

**v2 is additive.** Anyone who's already mid-flight on v1 sees the same
"Shared with me" UX they shipped. Mount becomes a new opt-in command:
`clawdi scope mount <shared-scope> --into <owned-scope> --alias <name>`.

---

## What v1 ships (recap)

- `ScopeMembership(user_id, scope_id, role=viewer)` — "Bob is a viewer of
  Alice's scope"
- `scope_ids_visible_to(auth)` returns the union of owned + member scopes
- Listings (`/api/skills`, `/api/vault`) filter by visible-scope set
- Skills land on disk as `<key>__<owner-handle>/` to namespace shared
  content distinctly from the sharee's own

This is the **permission layer**. It answers "who can see what?"

It does NOT answer:
- How a team composes a workspace from multiple contributors
- How a vendor publishes a starter pack that all users mount
- How a sharee selectively pulls a sub-tree
- How vault key collisions resolve (Alice's `OPENAI_KEY` vs Bob's)

## What's the abstraction gap

The shipping demo conflates two concerns into one. When Bob runs `share
accept`, he gets both:

1. **A capability** — Bob CAN see Alice's scope (the membership row).
2. **A presentation** — Alice's scope shows up in Bob's "Shared with me"
   section, and Alice's skills land on Bob's disk under `__alice-handle/`.

These should be separable. The capability is a low-level grant; the
presentation is one of many possible UX layouts of that grant. The v1
demo bakes one specific presentation in.

## Use cases that v1 cannot express

1. **Team workspace = union of contributors**

   "Engineering" = mount(alice/auth-skills) + mount(bob/db-skills) +
   mount(carol/deploy-skills). Each contributor owns + edits their slice;
   the team scope is a view, not anyone's source-of-truth.

2. **Vendor-curated starter packs**

   Anthropic publishes `@anthropic/best-practices`. New users mount it
   into Personal. Anthropic updates the pack — every mount sees the new
   version. With v1: each user re-accepts after every update, lives with
   the suffix forever.

3. **Selective inclusion**

   "I want Alice's `git-helper` skill, not her vault." v1 is all-or-nothing
   at scope granularity.

4. **Layered vault precedence**

   `$OPENAI_API_KEY` in Personal (my own key), `$OPENAI_API_KEY` in
   team-workspace (org shared key). Which wins? With v1, both surface in
   `vault list` with no resolution rule.

5. **Non-transitive sharing**

   I mount Alice's `engineering` into my `team-workspace`. I share
   `team-workspace` with Dave. Does Dave see Alice's content?
   **Membership-only answer:** Dave inherits everything visible to
   team-workspace, including Alice's content — even though Alice didn't
   authorize Dave specifically. That's a backdoor permission expansion.
   **Mount answer:** Dave needs his own independent membership to
   Alice. Mount is *config on the parent*, not a grant on the source.

## The architecture

### Data model

```
ScopeMount
  ─────────────
  id              uuid
  parent_scope_id uuid  → Scope.id  (the composition container)
  source_scope_id uuid  → Scope.id  (the included content)
  alias           text  (display name within parent, default = source.slug)
  mode            enum  { live | snapshot_rev_N }
  include_policy  json  { skills?: ["pattern"], vault?: ["pattern"] }
  created_by      uuid  → User.id
  created_at      timestamptz

  unique(parent_scope_id, source_scope_id)
  index(parent_scope_id), index(source_scope_id)
```

### Resolution rule (the safety invariant)

When the API resolves "skills in scope X" for user U:

```
visible_skills = [skills directly in X]
for each mount in scope_mounts where parent_scope_id = X:
    if source_scope_id IN scope_ids_visible_to(U):
        visible_skills += [skills in source filtered by include_policy]
```

**Key invariant:** A mount edge is configuration on the parent scope, NOT
a permission grant on the source. The viewer must independently hold read
access to the source. If they don't, the mount silently filters out
that content.

Consequence: **transitive sharing is impossible by construction.** Bob's
mount of Alice's scope doesn't backdoor Dave into Alice's content — Dave
needs his own membership.

### Why shallow-only (no recursion) in v2

A composition graph with depth N opens:
- Cycle detection complexity
- Query fan-out: walking 5-deep mount chains
- Unbounded vault key precedence chains

For v2, **mounts are shallow**: parent → source is the only edge type
we resolve. A scope that's itself a composition (has its own mounts)
is treated as a single source when mounted again. v3 can lift this
if real demand surfaces.

### Vault key precedence

Mount mode `live`:
- Parent's own keys win over mount keys.
- Among mounts: order matters. Listing order (or `mount_priority`
  column added later) is the tiebreak.
- `clawdi vault resolve` returns the winning key + a `--debug` flag
  shows where each name comes from.

### Write semantics

**Default: parent scope only.** Writes to a parent scope go to the
parent's own rows. Mount sources are read-only includes.

To write into a mounted source, the user re-runs the command targeting
the source explicitly: `clawdi skill add ./fix --scope alice/engineering`
(only works if Alice gave them editor role, which v1 doesn't support
yet — orthogonal feature).

## CLI surface (v2 additions)

```
# Mount a scope you have membership for into one of your owned scopes
clawdi scope mount <source-scope> --into <owned-scope> --alias <name>

# List mounts on a scope
clawdi scope mounts <owned-scope>

# Unmount
clawdi scope unmount <owned-scope> --source <alias>

# Existing `share accept` UNCHANGED — still creates a membership.
# Users who want composition explicitly opt in by running `scope mount`
# after acceptance.
```

`share accept` could optionally auto-mount under a flag — e.g.,
`share accept <url> --mount-into <parent>`. Default behavior stays the
current v1 shape so existing demos and onboarding paths don't break.

## Migration path (v1 → v2)

**v1 stays the source of truth for permissions.** The mount table is
purely additive — no migration of existing memberships into mounts.

**The web UI grows a section.** "Shared with me" stays (the capability
inbox). Each owned scope gains a "Mounted sources" panel showing what's
included.

**Feature flag.** Mount endpoints land behind `feature_scope_mounts`.
Self-hosted deploys without the flag see no behavior change.

**Demo doc gets a v2 chapter.** The current demo doc continues to be the
v1 walkthrough. A new chapter at the bottom shows "and once mount lands,
this same Engineering scope can also be composed of Alice + Carol + Bob
contributions, with these commands…".

## Open questions deferred to v2 implementation

1. **Mount-of-mount semantics** — when mount source is itself a parent
   with mounts, do we walk one level or be silent? v2: silent. v3: TBD.

2. **Default alias** — `source.slug` works if unique within parent. What
   if Alice and Bob both have `engineering`? Need a uniqueness check at
   mount time + suggested alias.

3. **Sync engine** — daemon's skill-pull walks `scope_ids_visible_to`.
   Mount adds an extra resolution layer. Probably belongs in the
   resolution helper, not the daemon. But the on-disk path layout
   (`__owner-handle` vs `@alias/owner-handle`) needs design.

4. **Discoverability of public starter packs** — out of v2 scope. Mount
   as primitive enables it; a marketplace UI is a separate feature.

## Codex's review confirmed

The architectural review (codex, this date) confirmed:

- v1 membership IS the right primitive for what it serves
- Mount IS a real abstraction win for compositional use cases — not
  over-engineering
- The two are at different layers, not competing
- v2 should be **additive, shallow, non-transitive, read-only-first**
- Existing v1 sharees must not see any behavior change

## Recommendation

**Ship the demo we have as v1. Plan v2 as a separate PR cycle**, ideally
after a real composition use case (team workspace OR vendor starter pack)
materializes in user feedback.

Until then:
- Keep `accept` → membership → "Shared with me" semantics intact.
- Add this RFC to the spec directory so the abstraction story is
  documented even if not yet built.
- Update the v1 demo doc to acknowledge the abstraction boundary so
  reviewers understand "this is the primitive, mount is the composition
  layer on top of it later."

---

## References

- Shipped design: `docs/superpowers/specs/2026-05-11-scope-sharing-design.md`
- Shipped demo: `docs/scenarios/scope-sharing-demo.md`
- Codex review thread: (this date) — kept the recommendation alive in
  the team's discussion record
