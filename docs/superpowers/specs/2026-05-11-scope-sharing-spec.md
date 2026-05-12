# Scope Mount — Sharing as Workspace Composition

> **Status:** Shipping spec for cross-user scope sharing on
> `feat/scope-sharing`. No production migration — earlier iterations
> on the same unmerged branch are superseded outright.

---

## Summary

`accept` **mounts the source scope INTO one of your owned scopes**.
Your scopes are composable workspaces — your own content plus mounted
contributions from people who shared with you.

Two-layer data model:
- `ScopeMembership` is the **capability** primitive — it answers
  *can the viewer read this source?*
- `ScopeMount` is the **composition** primitive — it answers
  *where does the viewer see it?* — composition lives at the scope
  layer, not the user layer.

Both tables ship together. They serve different questions; the read
resolver consults both at every request.

## Goals

- Make `accept` create a workspace mount, not just a permission grant.
- Enable team workspaces composed of multiple contributors' scopes.
- Enable vendor-published starter packs that auto-update across all
  users who mounted them.
- Keep membership as the underlying capability primitive so safety
  properties (anonymous redeem, env-bound deploy-key blast radius,
  revocation) compose cleanly with mount-based UX.

## Non-goals (deferred)

- Editor role / shared writes (sharees stay read-only)
- **Session sharing.** Mount applies to skills + vault metadata only.
  Sessions are conversation transcripts: high-volume, machine-tied,
  often containing PII or unredacted secrets. Sharing them via mount
  would surface every contributor's conversation history to every
  member of a composed scope — wrong UX for collaboration. If
  session-handoff is a real need later, design a per-session
  shareable-snapshot artifact (different primitive entirely).
- **Memory sharing.** Memory items are personal context vectors. They
  encode preferences, recent project context, and inferred user state.
  Composing those across users would be a privacy + identity leak
  surface, AND the embedding/recall layer assumes "this is what I
  asked about" semantics. Off-the-table.
- Recursive mount-of-mount resolution (shallow only in this iteration)
- Per-skill / per-vault-key `include_policy` filters (future, when
  there's evidence selective inclusion is a real need)
- Marketplace / discovery of public scopes (out of scope; word-of-mouth
  share-link distribution covers what users actually want today)
- Revisiting auth model (Clerk JWT + unbound CLI api_key only)

## Mental model

Two layers, separated by purpose:

| Layer | Table | Question it answers | Lifecycle |
|-------|-------|---------------------|-----------|
| Capability | `ScopeMembership` | "Can the viewer read scope X?" | Created by `inbox accept`; bound to user × scope |
| Composition | `ScopeMount` | "Where does scope X appear in the viewer's workspace?" | Created by `scope mount` (or implicit auto-mount on `inbox accept`); bound to parent-scope × source-scope |

**Critical invariant:** mount edges are configuration on the PARENT
scope, not grants on the SOURCE. Mount resolution always re-checks
the viewer's independent membership in the source. If the viewer
re-shares the parent to a third party, that third party only sees
mount sources they have independent membership to — transitive
permission expansion is structurally impossible.

## Personas

- **Owner** — owns a scope, publishes it.
- **Sharee (anonymous)** — has a URL, no account yet.
- **Sharee (registered)** — has a Clawdi account; receives invitation
  OR signs in after anonymous redeem.

## User journeys

### J1 — Owner generates a share link

`clawdi share <scope> [--label <text>]` → URL printed once on stdout
(confirmation message goes to stderr so the URL pipes cleanly into
clipboards / scripts). Server stores only the SHA-256 hash + prefix +
frozen `resolved_owner_handle`.

### J2 — Anonymous sharee accepts a link

`clawdi inbox accept <url>` from a logged-out terminal:
1. Server creates a `share_token` redemption row (capability-layer write).
2. CLI stores raw token in `~/.clawdi/share-tokens.json`.
3. **No mount yet** — an anonymous user has no owned scope to mount
   INTO. Mounting happens on the eventual `inbox accept <same-url>` after
   `clawdi auth login` (J3 below); the existing redemption token gives
   the daemon limited skill-pull capability in the meantime.

### J3 — Anonymous sharee later logs in (upgrade path)

After `clawdi auth login`, the post-login hook **automatically scans
`~/.clawdi/share-tokens.json`** for entries without `upgraded_at` and
POSTs `/upgrade` for each:
1. Server creates `ScopeMembership` (capability-layer write).
2. Server resolves the **mount target** by the rules in § "Auto-mount
   target resolution" below, then creates a `ScopeMount` row if one
   doesn't already exist for that `(parent, source)` pair.
3. CLI prints "Auto-upgraded N pending shares → N mounts." on success;
   keeps the entry + surfaces the reason on per-token failure (410
   revoked, 409 mount-target-ambiguous → "run `clawdi scope mount` to
   pick a parent").
4. Daemon eager-pulls skills under each new mount's adapter path layout.

The user does NOT need to re-run `inbox accept` for redemptions they
already did anonymously. Running it manually is still allowed and
idempotent.

### J4 — Registered sharee accepts an email invitation

`clawdi inbox accept <id>` (or web dashboard click):
1. Server creates `ScopeMembership` (capability-layer write).
2. Server resolves mount target by the same rules and inserts a
   `ScopeMount` row.
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
4. **Conflict-warning at mount-creation time.** When `inbox accept` /
   `scope mount` is about to create a row that exposes a vault key
   already defined on the parent or another existing mount of the same
   parent, the response includes `vault_conflicts: [...]` and the CLI
   prints a yellow warning before continuing. Non-interactive callers
   can pass `--allow-vault-conflicts` to accept the warning silently.
   See § "Vault precedence" for the full conflict-detection rules.

## Auto-mount target resolution

When `inbox accept` runs without an explicit `--into <parent>`, the
server picks the mount target by counting the caller's *owned* scopes:

| Owned scopes | Behavior |
|--------------|----------|
| 0 | Impossible by construction (every signup gets a Personal scope). |
| 1 | Auto-mount into that scope. Silent. |
| 2+ | **Refuse to guess.** Server returns `409 mount_target_ambiguous` with the full list of owned scope ids/slugs. The CLI rephrases that as an interactive picker (or `--into <scope>` for non-interactive callers); the web dashboard shows a small picker before completing the accept. |

The "most-recently-active" heuristic was rejected: it produces
surprising mounts when a user actively works in scope A but their last
`clawdi pull` happened to run in scope B. Forcing a choice avoids
silent mismatch.

`--no-mount` skips this resolution entirely (capability-only accept).

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
       (Use POST /api/scopes/{source_scope_id}/leave to drop the
        underlying membership too.)
```

### `accept` paths

`POST /api/share/{token}/upgrade` (logged-in share-link redemption):
- Inserts `ScopeMembership` (the capability).
- Resolves mount target via § "Auto-mount target resolution":
  - 1 owned scope → inserts a `ScopeMount` row in the same transaction.
  - 2+ owned scopes WITHOUT body `parent_scope_id` → returns
    `409 mount_target_ambiguous` with `owned_scopes: [...]`. The
    membership row is **still created** (capability still acquired);
    the caller re-POSTs with explicit `parent_scope_id` to complete
    the mount, OR calls `scope mount` later.
- Both inserts are idempotent on `(user, scope)` and `(parent, source)`.
- Request body (optional): `{parent_scope_id?: uuid, alias?: string,
  allow_vault_conflicts?: bool}`.
- Response payload: `{membership_id, mount_id?, mount_alias?,
  resolved_owner_handle, scope_id, vault_conflicts: [...]}`.

`POST /api/me/invitations/{id}/accept` (registered sharee accepts invite):
- Same shape — capability always lands; mount conditional on
  resolvable target.

`POST /api/share/{token}/redeem` (anonymous redemption):
- Capability-only: writes the redemption count + last-redeemed timestamp.
- No mount (the caller has no owned scope yet). The eventual
  `inbox accept <url>` after `clawdi auth login` creates both rows.

### Read endpoints

`GET /api/skills`, `GET /api/vault`:

Two distinct resolution surfaces depending on whether the caller pinned
a parent scope or asked for "everything I can see":

**Unscoped read** (no `?scope_id=…`): returns the union of
`scope_ids_visible_to(auth)` directly. Mount edges are not unfolded
in this mode — the caller asked for "everything I can see", not
"everything composed into a specific parent".

**Parent-scoped read** (`?scope_id=<parent>`): walks mount edges
rooted at that parent, gated on viewer-source membership.

```
def resolve_for_parent(parent_scope_id, auth):
    visible = scope_ids_visible_to(auth)
    if parent_scope_id not in visible:
        return []                                    # 404 equivalent

    composed = {parent_scope_id}
    for mount in db.query(ScopeMount).where(
        parent_scope_id == parent_scope_id
    ):
        if mount.source_scope_id in visible:         # capability re-check
            composed.add(mount.source_scope_id)
    return composed
```

The viewer-source membership re-check is the safety invariant. A mount
edge that points at a scope the viewer cannot independently see is
silently filtered out — transitive permission expansion is impossible
by construction.

Skill / vault listings then filter on `Resource.scope_id IN composed`.

### `GET /api/me/scopes` shape

Returns one section, `scopes`, each entry carrying:
- the scope's metadata
- `is_owner` flag
- `mounts: [...]` array when the user owns the scope (always empty
  for non-owned shared scopes — mounts live on owned parents only)

No separate `shared` array. Mounts under owned scopes are the only
surface that needs to render shared content.

## CLI surface

v2 reorganizes the CLI around three nouns so an agent reading `--help`
or a command transcript can place every operation on a mental map:

| Noun | Purpose |
|------|---------|
| `clawdi scope`   | My scope inventory + composition |
| `clawdi share`   | Outgoing — what I'm publishing to others |
| `clawdi inbox`   | Incoming — invitations + URLs awaiting my action |

Each verb has one home. `accept` lives only in `inbox`. `revoke` lives
only in `share`. No subcommand carries two meanings.

### `clawdi scope` — inventory + composition

```bash
clawdi scope list                                   # tree: owned + mounted
clawdi scope show <scope>                           # detail incl. mounts
clawdi scope mount <source> --into <parent>         # add a mount edge
       [--alias <name>]                              # default: @<owner>/<source-slug>
clawdi scope unmount <alias-or-source>              # detach mount edge
       --from <parent>
clawdi scope mounts <scope>                         # list mounts under one scope
```

**`scope mount <source>`** accepts an explicit source-scope UUID, slug,
or human name. It does NOT accept share URLs — URL redemption is `inbox`
territory. If the caller doesn't already have membership in the source,
the command 403s with a hint to run `inbox accept <url>` first.

**`scope list` output** (no more "Shared with me" section):

```
$ clawdi scope list

My scopes (1):
  personal-bob            8f3a...  (personal)
    Personal
    └─ @alice/engineering  ← mount: 1 skill, 3 vault secrets
    └─ @carol/deploy       ← mount: 2 skills, 0 secrets
```

### `clawdi share` — outgoing publication

```bash
clawdi share <scope> [--label <text>]               # generate a public URL
clawdi share <scope> --to <email>                   # send email invitation
clawdi share <scope> --list                         # list outgoing publications
                                                     # AND who has accepted them
clawdi share <scope> --revoke <id-or-prefix>        # revoke link OR cancel invite
```

ONE root verb (`share`); the publication shape is chosen by flags. The
caller's mental model is "I'm publishing this scope to someone" — the
flag picks public-link or private-invitation.

`<scope>` accepts UUID, slug, or human name. Output sends the raw URL
to stdout, confirmation message to stderr — so `clawdi share my-scope
| pbcopy` pipes the URL directly.

**`share <scope> --list` output** combines three rows-per-section so
owners can see acceptance state (critical for "is this leak worth
rotating my secrets?" decisions):

```
$ clawdi share team-toolkit --list

Share links:
  doHT_f7l… [weekend hack]  active  3 redeems · last 2026-05-12
  zKpA9q2…  [old]           revoked

Pending invitations (waiting for acceptance):
  bob@x.dev    sent 2026-05-12

Members (accepted invitations + upgraded share-links):
  alice@y.dev     via @link doHT_f7l…  joined 2026-05-12
  carol@z.dev     via invite           joined 2026-05-13

Anonymous redemptions:
  3 redemptions, last seen 2026-05-12T14:22Z  (no identity captured)
```

Anonymous-redemption row shows count + last-seen only — no identity.
The owner uses this to decide whether to rotate vault secrets.

The backend exposes this as three sub-routes returning their own
payloads (`GET /api/scopes/{id}/share-links`,
`GET /api/scopes/{id}/invitations`, `GET /api/scopes/{id}/members`)
plus a new `GET /api/scopes/{id}/share-links/{link_id}/redemptions`
that aggregates the anonymous redemption count + last-seen
timestamp. The CLI calls all four and renders the combined view.

### `clawdi inbox` — incoming, awaiting my decision

```bash
clawdi inbox                                        # list pending invitations
clawdi inbox accept <id-or-url>                     # accept invitation OR redeem URL
       [--into <parent>] [--alias <name>]            # mount target overrides
       [--invite | --url]                            # disambiguator (rarely needed)
       [--no-mount]                                  # capability-only, skip mount
clawdi inbox decline <id>                           # decline a pending invitation
clawdi inbox forget <id-or-alias>                   # local-only: drop a redeemed
                                                     # share-token state (no server
                                                     # call — drops the
                                                     # share-tokens.json entry)
```

**`inbox accept` polymorphism.** The single positional argument
auto-detects shape after stripping common copy-paste wrappers:

```python
def normalize_accept_arg(raw: str) -> str:
    s = raw.strip()
    # Strip Markdown-link wrappers: <https://...>, [text](url).
    if s.startswith("<") and s.endswith(">"):
        s = s[1:-1]
    # Strip trailing punctuation common to chat messages (",.!;:").
    s = s.rstrip(",.!;:")
    # Strip surrounding quotes (single or double).
    if (s.startswith('"') and s.endswith('"')) or \
       (s.startswith("'") and s.endswith("'")):
        s = s[1:-1]
    return s
```

After normalization:
- UUID-shaped → pending invitation accept
- Anything starting with `http://` or `https://` → URL redemption
- 32-char URL-safe base64 → raw token (passed without the host part)
- Anything else → 1-line error citing both example shapes

`--invite <id>` / `--url <link>` are explicit escape hatches that
bypass shape detection for scripted callers.

### Share URL shape

The URL stored on a share link is **path-only** — no query string:

```
http(s)://<host>/share/<43-char-url-safe-base64-token>
```

Path-segment tokens survive unquoted shell pastes (no `?`/`&` for
zsh/bash to interpret). The web landing page route is
`/share/[token]` — that's the same URL serving both the browser
landing experience and the CLI accept consumer; the CLI just hits
the share-token POST endpoints directly.

**`inbox forget`** is local-only: no server call. Drops the
share-tokens.json entry for a redeemed URL — useful for cleaning up
an old anonymous-redemption laptop.

### Default mount behavior on `inbox accept`

- Logged in → membership row + mount row created in the user's
  default-write scope (alias `@<owner-handle>/<source-slug>`, suffix-
  bumped only on collision; see § Hard questions #7)
- Logged out (URL case) → token stored locally; no mount yet
- `--no-mount` → capability only (membership row), no mount edge
  — for the rare user who wants to inspect content before composing
- `--into <parent> --alias <name>` → override default mount target

### Future commands not yet implemented

- `clawdi scope members <scope>` — list/remove members on a scope (owner view)
- `clawdi scope unshare <scope>` — kill all links + members in one call
- `clawdi scope leave <scope>` — sharee drops membership; cascade removes
  any mounts pointing at the dropped source from their owned scopes

## Web surface

Same three-noun shape as the CLI: **Scopes** page (inventory + mounts),
**Share** dialog (owner publication), **Inbox** banner (pending
invitations).

### CHANGED: Inbox banner accept handler

The `Inbox` banner component lists pending invitations + URL-redeemed
shares awaiting auth. On accept: toast says "Mounted into your Personal
scope as @alice/engineering" — no separate "Shared with me" section.

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

Adapter on-disk layout uses `<key>__<owner-handle>/` (e.g.
`~/.claude/skills/git-helper__alice-a3b4/`). The mount alias only
matters at the API / CLI listing layer; the daemon eager-pull writes
to `getSharedSkillPath(key, owner_handle)`.

A future iteration could expose mount aliases in the adapter path for
cleaner multi-source overlay UX, but that's an opt-in adapter change,
not a mount-spec concern.

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

### Conflict warning at mount-creation time

Silent "oldest mount wins" is unsafe for non-interactive agent runs.
Mount creation actively detects collisions:

```python
def detect_vault_conflicts(parent_id, source_id, auth):
    """Return [{key, parent_alias, mount_alias, would_win_alias}, ...]
    for every vault key in `source` that ALSO exists either on the
    parent or on another already-mounted source of `parent`. Empty
    list = no conflicts."""
```

The result rides on every `POST /upgrade`, `POST /me/invitations/{id}
/accept`, and `POST /api/scopes/{id}/mounts` response in the
`vault_conflicts: [...]` field. CLI/web render:

```
$ clawdi inbox accept https://.../share/abc...
✓ Joined as viewer.
⚠ vault keys in conflict with your existing scope:
    OPENAI_KEY    parent-own (wins)  vs  @alice/engineering (skipped)
    SENTRY_DSN    @bob/legacy (wins) vs  @alice/engineering (skipped)
  → pass --allow-vault-conflicts to silence, or unmount @bob/legacy first.
```

Non-interactive callers (`--yes` or `CI=1`) must pass
`--allow-vault-conflicts` or the command exits 1 with the same warning
on stderr. This forces the operator to see the precedence choice
before relying on an automated agent run.

## Phasing (implementation plan summary)

See `docs/superpowers/plans/2026-05-12-scope-sharing.md` for full task
breakdown.

| Phase | What lands | Risk gate |
|-------|------------|-----------|
| MA — Models + migration | `ScopeMount` table, no behavior change | Membership read-path tests still green |
| MB — Mount endpoints | CRUD on mounts, owner-only | Cross-tenant 404 isolation |
| MC — Auto-mount on accept | `/upgrade` + invite-accept also mount; 409 mount_target_ambiguous when 2+ owned scopes | Idempotent on retry (natural-alias-first; suffix only on collision) |
| MD — Read resolution + vault precedence + conflict warning | Skill/vault reads walk mounts; mount-create surfaces `vault_conflicts` | Parent-scoped queries return composed content; viewer-source capability re-check holds |
| **ME1 — Minimal CLI demo surface** | `share`, `inbox accept`, `scope list`, `vault resolve --debug` — just enough for end-to-end three-persona walkthrough | Polymorphic `inbox accept` handles `<https://…>` / quoted / trailing-punct shapes |
| **ME2 — Mid-pipeline demo capture** | Three-persona live demo run, output saved | Validates product semantics BEFORE web reorg builds on top |
| ME3 — Full three-noun CLI reorg | `scope mount/unmount/mounts`, `share <scope> --list/--revoke/--to`, `inbox forget` | Old v1-shape commands deleted (no aliases) |
| MF — Web: `Inbox` banner + per-scope mounts panel + share `--list` UI | User-visible surface on dashboard | Web build + manual smoke |
| MG — Final test sweep + demo doc finalization | Test counts recorded; demo doc reflects final command shapes | 225+ backend + 280+ CLI tests still green |

## Hard questions resolved in this spec

1. **Single table or two?** Two. `ScopeMembership` answers "can the
   viewer read this source?"; `ScopeMount` answers "where does it
   appear in their workspace?". Different lifecycles, different
   safety semantics, different write paths.

2. **Transitive sharing?** Impossible by construction — mount edges
   re-check viewer membership against source at every read.

3. **Anonymous redeem mount target?** Deferred until login. Mount
   only created during `/upgrade` (post-auth), not `/redeem`.

4. **Vault key collisions?** Parent-own wins; then mounts in
   `created_at` ASC order. `clawdi vault resolve --debug` surfaces
   the precedence chain.

5. **Write semantics?** Writes target the resolved scope (parent or
   explicit `--scope`), never silently into a mount source. To write
   to a mount source the user must `--scope <source-slug>` explicitly,
   which requires editor role (a future feature).

6. **Recursive mount-of-mount?** Not now. Shallow only. v3 candidate.

7. **Alias collision on auto-mount?** Default alias is the *natural*
   form `@<owner-handle>/<source-slug>` (no suffix). Suffix `-2`,
   `-3`, ..., `-9` ONLY applied when an alias actually collides
   within the same parent scope. After 9 attempts the API returns
   `409 alias_collision` and the caller passes `--alias` explicitly.
   The bare-form-first rule keeps natural aliases readable
   (`@alice/engineering`, not `@alice-a3b4/engineering-xyz`).

## Codex architectural review (recorded)

A codex-rescue session reviewed the design before shipping. Key
findings encoded in this spec:

- Membership is the right capability primitive — not over-engineering.
- Mount IS a real abstraction win for composition use cases.
- The two layers don't compete; they answer different questions.
- Single-table replacement would have been the wrong move — anonymous
  redeem and email invitation both need a capability primitive that
  pre-exists any parent-scope choice.
- Shallow, non-transitive, deterministic alias collisions are the
  safe shape.

## References

- Implementation plan: [`docs/superpowers/plans/2026-05-12-scope-sharing.md`](../plans/2026-05-12-scope-sharing.md)
