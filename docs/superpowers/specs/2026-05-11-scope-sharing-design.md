# Cross-User Scope Sharing — Design Spec

**Status**: Draft, awaiting implementation plan.
**Date**: 2026-05-11.
**Branch**: `feat/scope-sharing`.
**Companion repos**: none (cloud-api + dashboard + CLI all in this monorepo).

## 1. Summary

Today a Clawdi user can sub-divide their content with **scopes** (a Personal
scope per user plus one env-local scope per registered agent machine), but
those scopes are single-tenant — `users.id` is the tenancy boundary and
`scope_id` only sub-divides within one user. The scope model has always
reserved space for cross-user sharing
(`docs/plans/env-scoped-skills.md` → "Cross-user sharing (ScopeMembership)"),
but the schema, API, CLI and UI have not yet shipped any of it.

This spec ships **v1 of cross-user scope sharing** with two flagship flows:

1. **Public share link** — any owner can generate an opaque-token URL.
   Anyone with `clawdi` installed can redeem the link from the CLI **without
   signing up**, immediately pulling the scope's skills to disk for use by
   their AI agent. Vault items in the scope are visible as metadata but
   plaintext resolution requires a Clerk-bound identity (an explicit
   "upgrade incentive" that we want to surface, not hide).
2. **Email invitation** — owners can invite an already-registered user by
   email. The invitee sees a pending invitation in their dashboard and
   accepts or declines. No silent membership creation.

Both flows produce rows in a single `scope_memberships` table; CLI sharees
who later sign in upgrade their local share-tokens to permanent memberships
in one step.

The design is modeled on the patterns shared by Figma view-links, Spotify
playlist URLs, Apple Shared Albums and Google Drive "anyone with link"
sharing — anonymous access is a **read-only stream**, signing up is an
**upgrade to first-class membership**. We do **not** introduce an
anonymous user row; anonymous redemption is purely token-bound, with no
data to "claim" because the only thing the sharee has on disk is the
owner's content.

## 2. Goals and Non-Goals

### Goals (v1)

- Cross-user sharing for **skills** (full read) and **vaults** (metadata
  visible to anyone; plaintext resolution requires Clerk-bound viewer
  membership).
- Two ingress paths — share link (anonymous CLI-friendly) and email
  invitation (pending until accepted).
- Owner + Viewer role model. Viewers are strictly read-only; owners can
  manage members, generate / revoke links, and (since they're already
  the scope's only writer) push content through existing flows.
- Equal CLI and Web Dashboard coverage for every owner / sharee action
  except those that are fundamentally web-only (clicking a landing page,
  pending-invitation accept UI).
- Local skill layout that doesn't break existing agents (Claude Code,
  Codex, OpenClaw, Hermes glob `<root>/*/SKILL.md`) and never overwrites
  the sharee's own skills.
- Server-side `scope_ids_visible_to` extended so the existing
  `WHERE scope_id IN (...)` filters across the skill / vault / memory
  read paths automatically include shared scopes.
- Foreign keys + cascades modelled so deleting an owner deletes their
  shares cleanly, and revoking a member surgically removes one row.
- Zero impact on OSS self-hosters and self-managed users who never use
  sharing — feature is purely additive, gated by the presence of
  `scope_memberships` rows.

### Non-Goals (v1)

- **Memory sharing**. The memory subsystem doesn't yet enforce
  `scope_id` on its read paths consistently (see
  `env-scoped-skills.md` § "Memory / Vault scoping migration") and the
  Mem0 provider has its own tenancy model. Cross-user memory ships
  in a follow-up milestone.
- **Editor / Admin roles**. Viewer is the only non-owner role in v1.
- **Per-resource sharing**. You share a whole scope; you can't share
  one skill or one vault item independently. Granular sharing is a
  follow-up.
- **Vault per-member envelope encryption**. v1 reuses the existing
  server-side `VAULT_ENCRYPTION_KEY` decryption with access control
  enforced at the API layer. The pure-cryptography milestone
  (per-member encrypted DEK) is deferred — see § 10.
- **Marketplace / discovery**. There is no global skill catalog,
  no rating, no search across users. v1 is push-link, not pull-from-feed.
- **Audit log**. v1 records `joined_via` and `joined_at` on the
  membership row, but rich event audit (link redeemed by IP, member
  removed by whom) is a follow-up.
- **Self-managed sharee dashboards on cloud-api**. The anonymous
  redeem flow does not give the sharee a web account. They get a
  CLI experience only until they `clawdi auth login`.

## 3. Personas

| Label | Description |
|---|---|
| **Owner** | A registered Clerk user who owns one or more scopes. Wants to share content with collaborators without forcing them to sign up first. |
| **Anonymous Sharee** | Has `clawdi` CLI installed (or installs it on arrival). Does not have a Clerk account. Redeems a share link from the terminal, pulls skills to disk, uses them with their AI agent. |
| **Registered Sharee** | Has a Clerk account. Receives either an email invitation (in-dashboard pending invite) or a share link (which they redeem via web "Add to my dashboard" or CLI auto-membership). |
| **Mixed user** | Owns some scopes, is a viewer member on others. The UI must clearly separate "My scopes" from "Shared with me" everywhere they appear. |

## 4. User Journeys

The table enumerates every supported action, by persona × surface. **Web**
means the cloud.clawdi.ai dashboard; **CLI** means the `clawdi` command.
Dashes (`—`) indicate "surface not applicable" (e.g., owners don't redeem
their own links).

### 4.1 Owner

| Action | Web | CLI |
|---|---|---|
| Generate share link | Scope detail → Sharing tab → `Generate share link` → copy URL | `clawdi scope share <scope-id-or-slug>` → prints URL + redeem hint |
| List share links | Sharing tab → Links section, with redeem count | `clawdi scope share-links <scope-id>` |
| Revoke share link | Link row → `Revoke` | `clawdi scope share-links <scope-id> --revoke <link-id>` |
| Invite by email (pending) | Sharing tab → `Invite by email` → email input | `clawdi scope invite <scope-id> --email <email>` |
| List members + pending invites | Sharing tab default | `clawdi scope members <scope-id>` |
| Cancel a pending invite | Member row → `Cancel invitation` | `clawdi scope invites <scope-id> --cancel <invite-id>` |
| Remove a member | Member row → `Remove` | `clawdi scope members <scope-id> --remove <email-or-id>` |
| Stop sharing entirely | Sharing tab → `Stop sharing` (revokes all links + removes all members) | `clawdi scope unshare <scope-id>` |
| Edit scope content (propagates) | Existing skill / vault editors | Existing `clawdi push` / `clawdi serve` |

### 4.2 Anonymous Sharee (CLI-only, no Clerk account)

| Action | Web | CLI |
|---|---|---|
| Open link from owner | `clawdi.ai/share/<token>` landing page: shows owner display name, scope name, skill count, vault count (locked), copy-able redeem command, "Get the CLI" install instructions, and "Sign in instead to add directly" CTA | — |
| Redeem the share | — | `clawdi share accept <url>` → token stored in `~/.clawdi/share-tokens.json` → skills tar pulled to `<adapter-root>/<key>__<owner-handle>/` |
| List accepted shares | — | `clawdi share list` shows owner display, scope, redeem time, vault-lock count |
| Use the skills | — | Skills are visible to the agent at the adapter's normal skills root; agent auto-discovers them |
| Skill references vault | — | CLI errors with hint to run `clawdi auth login` and the share-token will auto-upgrade |
| Remove a share locally | — | `clawdi share remove <scope-id>` → deletes local token + cached skills |
| Owner revoked the link | — | Next sync round returns 410/403 → CLI prints `Owner revoked this share; cleaning up` and auto-removes |
| Sign up later | Sign up at `clawdi.ai` (Clerk hosted UI) | After web sign-up, `clawdi auth login` → CLI detects local share-tokens → interactive prompt `Convert N pending shares to memberships? [Y/n]` → server creates memberships → tokens deleted |

### 4.3 Registered Sharee (has Clerk account)

| Action | Web | CLI |
|---|---|---|
| Open link from owner | Landing page detects Clerk session → replaces the redeem-command block with an `Add to my dashboard` button that creates a viewer membership directly | — |
| Receive email invitation | Sidebar `Scopes` badge appears → invite shows in scope list with `Accept` / `Decline` actions | `clawdi scope invites` shows pending invitations |
| Accept invitation | `Accept` on the invite | `clawdi scope invites --accept <invite-id>` |
| Decline invitation | `Decline` on the invite | `clawdi scope invites --decline <invite-id>` |
| List scopes I belong to | Sidebar separates `My scopes` and `Shared with me` | `clawdi scope list` (column marks `shared_with_me`) |
| Browse shared skills | Skills list page filtered to the scope shows entries with `shared from @owner` tags, read-only | `clawdi skill list --scope <shared-scope>` |
| Browse shared vault | Vault list page shows vaults + items metadata, read-only | `clawdi vault list --scope <shared-scope>` |
| Resolve a shared vault secret | (Web dashboard never resolves plaintext) | Existing `clawdi run` / `clawdi vault get` work — membership satisfies the gate |
| Leave a shared scope | Shared scope detail → `Leave` | `clawdi scope leave <scope-id>` |
| Multi-device | Not applicable | Second device `clawdi auth login` → memberships auto-enumerated, skills sync without explicit redeem |

### 4.4 Mixed user

Both views co-exist for the same user. Scope-detail pages branch on
`is_owner` from `/api/scopes/{id}` (new flag, derived from
`scope.user_id == auth.user_id`):

- **Owner view** — Sharing tab visible, edit affordances on, "Leave"
  hidden.
- **Sharee view** — Sharing tab hidden, edit affordances off, `Leave`
  visible, header reads `Shared from @<owner-display>`.

The CLI uses the same flag in its rendered tables (`clawdi scope list`).

### 4.5 Edge cases

| Case | Behavior |
|---|---|
| Owner tries to invite themselves by email | Server returns 400 with `already_owner` |
| Owner deletes a scope that has members | Existing `scope.user_id ON DELETE CASCADE` chain + `scope_memberships.scope_id ON DELETE CASCADE` clears everything; sharees' next sync returns 404 / 410 and CLI cleans up locally |
| Sharee already a member redeems same link again | No-op; server returns existing membership |
| Anonymous sharee redeems the same link twice | Local CLI prints `already accepted` (token uniqueness check) |
| Two different links to the same scope | Both valid until individually revoked; both produce membership rows with `joined_via='link'` after the sharee signs in |
| Owner removes a member, member redeems an OLD anonymous token | Token is still valid (token != membership). Owner must also revoke the link if the intent is "block this person entirely" |
| Anonymous sharee on device A signs in on device B | Device A keeps using its share-tokens until device A also signs in; device B's memberships are independent of device A's tokens |
| Pending invitation, owner removes the invite, invitee tries to accept | 410 Gone; invite no longer exists |

## 5. Architecture

### 5.1 Approach

**Token-based anonymous access + post-login membership upgrade**
(referred to internally as the "B refined" approach during brainstorming).

We deliberately **do not** introduce an anonymous user row. This is
inspired by mainstream products (Figma view-links, Spotify playlists,
Apple Shared Albums) which all treat anonymous access as a transient
read-only stream and registration as a fresh membership creation, with
no "claim history" step. The simpler model both reduces failure modes
(no user-merge transaction) and matches user mental models.

Key shape:

- **Anonymous redemption** — Owner generates a share link containing
  an opaque token. The CLI redeems it without auth, server returns
  scope content. The token itself is the bearer credential, scoped to
  `read:skill` and `read:vault_metadata` on one specific scope.
- **Token storage** — Server stores `sha256(token)` (never the raw
  token, exactly like API keys today). CLI stores the raw token in
  `~/.clawdi/share-tokens.json` (per-device file, 0600).
- **Membership** — Created on email-invite accept, web "Add to my
  dashboard", or token upgrade after CLI sign-in. Always tied to a
  real (Clerk-bound) `users.id`.
- **Vault gate** — Plaintext resolution requires the request to be
  authenticated as a Clerk-bound viewer member; share-token requests
  return 403 with a `sign_in_required` hint that the CLI surfaces.

### 5.2 Why this over "anonymous user row" (rejected alternative)

- No `users.kind = 'anonymous'` table proliferation.
- No data merge / claim transaction at sign-in time — sharees have
  nothing of their own on the server to merge.
- Aligns with `env-scoped-skills.md` § "Cross-user sharing
  (ScopeMembership)" which already names `scope_memberships` as the
  schema entry point. The shared-link layer is purely additive on top.
- The `device_authorizations` table reserved for OAuth device flow
  stays available for its real purpose (CLI sign-in), not repurposed.

### 5.3 Read-path access control

The existing `scope_ids_visible_to(db, auth)` in `app/core/scope.py`
already centralises "which scope_ids may this caller read." It is
extended with one new branch:

```
result_scope_ids = (
    user's owned scopes
    ∪ scopes where (scope_id, auth.user_id) ∈ scope_memberships
)
```

Anonymous share-token callers do **not** go through `scope_ids_visible_to`
— they go through a new `/api/share/...` router that validates token,
extracts `scope_id`, and uses it directly. This keeps the trust model
explicit: token holders never look like a logged-in user.

Env-bound CLI api-keys keep their current single-scope ceiling
(deploy-key blast radius); they cannot see shared scopes even if the
user owning them has memberships. This is by design — a leaked
env-bound key on a hosted pod must not gain visibility into scopes
the user has been added to by third parties.

## 6. Data Model

### 6.1 New tables

```sql
-- Membership of a user in a scope owned by another user.
CREATE TABLE scope_memberships (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_id      UUID NOT NULL
                  REFERENCES scopes(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL
                  REFERENCES users(id) ON DELETE CASCADE,
    role          VARCHAR(32) NOT NULL,  -- 'viewer' in v1, future: 'editor'
    joined_via    VARCHAR(32) NOT NULL,  -- 'invite' | 'link'
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The owner's display name + handle, frozen at join time so the
    -- sharee's local skill path doesn't churn if the owner renames.
    resolved_owner_handle VARCHAR(64) NOT NULL,

    UNIQUE (scope_id, user_id),
    CHECK (role IN ('viewer')),
    -- 'link' covers every share-link path (web "Add to my dashboard",
    -- CLI redeem with Clerk auth present, and post-anonymous
    -- token upgrade). The transit story doesn't change the
    -- membership row, so we don't multiplex it in this column.
    CHECK (joined_via IN ('invite', 'link'))
);

CREATE INDEX scope_memberships_user_id_idx ON scope_memberships(user_id);
CREATE INDEX scope_memberships_scope_id_idx ON scope_memberships(scope_id);

-- Outstanding invitations (email-based). Becomes a membership row
-- on accept; row is deleted on accept / decline / cancel.
CREATE TABLE scope_invitations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_id      UUID NOT NULL
                  REFERENCES scopes(id) ON DELETE CASCADE,
    invitee_email VARCHAR(320) NOT NULL,
    invited_by    UUID NOT NULL
                  REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (scope_id, invitee_email)
);

CREATE INDEX scope_invitations_email_idx ON scope_invitations(invitee_email);

-- One link per row. Owners can create multiple links per scope
-- (e.g. one to share with a team, one to share with a community).
-- Each link can be revoked independently.
CREATE TABLE scope_share_links (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_id       UUID NOT NULL
                   REFERENCES scopes(id) ON DELETE CASCADE,
    -- sha256(raw_token). Raw token never stored.
    token_hash     CHAR(64) NOT NULL UNIQUE,
    token_prefix   VARCHAR(8) NOT NULL,  -- first 8 chars for display
    label          VARCHAR(200),         -- optional owner-visible label
    created_by     UUID NOT NULL
                   REFERENCES users(id) ON DELETE CASCADE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ,          -- nullable = never expires
    revoked_at     TIMESTAMPTZ,
    redeem_count   INTEGER NOT NULL DEFAULT 0,
    last_redeemed_at TIMESTAMPTZ
);

CREATE INDEX scope_share_links_scope_id_idx ON scope_share_links(scope_id);
```

### 6.2 No changes to existing tables

- `users` — no new column; we deliberately do not introduce a `kind`
  field for anonymous-vs-clerk because no anonymous user row exists.
- `scopes` — `kind` stays as `personal | environment`; sharing is
  orthogonal to scope kind (any scope can be shared regardless of
  its origin). The doc-only `'shared' kind` reservation in
  `env-scoped-skills.md` is **not** taken.
- `skills`, `vaults`, `vault_items`, `memories` — no new columns;
  the existing `(user_id, scope_id)` is sufficient now that
  `scope_ids_visible_to` is broader.

### 6.3 Migration

Single Alembic migration, DDL-only (no data backfill since this is a
greenfield feature with zero existing membership rows):

1. `CREATE TABLE scope_memberships`
2. `CREATE TABLE scope_invitations`
3. `CREATE TABLE scope_share_links`
4. Indexes as listed.

No risk; production has 0 rows to migrate. Migration takes < 100ms.

### 6.4 SQLAlchemy models

Three new files under `backend/app/models/`:
- `scope_membership.py`
- `scope_invitation.py`
- `scope_share_link.py`

Each `from app.models.user import User` and `from app.models.scope
import Scope` so the FK string references resolve at import time.

## 7. API Surface

All new endpoints. Auth dependencies are explicit in the path; default
is `require_user_auth` unless noted (Clerk JWT or unbound CLI key, no
narrowly-scoped api keys).

### 7.1 Scope sharing — owner-facing

```
POST   /api/scopes/{scope_id}/share-links
       Body: { label?: string, expires_at?: ISO8601 }
       Returns: { id, raw_token, url, prefix, created_at, expires_at }
       Auth: require_user_auth, caller must own scope.
       Note: raw_token returned ONCE, server stores hash only.

GET    /api/scopes/{scope_id}/share-links
       Returns: ShareLinkResponse[]  (prefix, label, counts, no raw)
       Auth: require_user_auth, caller must own scope.

DELETE /api/scopes/{scope_id}/share-links/{link_id}
       Returns: { status: "revoked" }
       Auth: require_user_auth, caller must own scope.

POST   /api/scopes/{scope_id}/invitations
       Body: { email: string }
       Returns: InvitationResponse
       Auth: require_user_auth, caller must own scope.
       Errors:
         400 already_owner — email maps to scope owner
         404 user_not_found — email has no clawdi account
                              (CLI / web suggests sending share link instead)
         409 already_member — email already a member
         409 already_invited — pending invite exists

GET    /api/scopes/{scope_id}/invitations
       Auth: require_user_auth, caller must own scope.

DELETE /api/scopes/{scope_id}/invitations/{invitation_id}
       Auth: require_user_auth, caller must own scope (or be invitee).

GET    /api/scopes/{scope_id}/members
       Returns: MemberResponse[]  (user_id, email, name, joined_via, joined_at)
       Auth: require_user_auth, caller must own scope.

DELETE /api/scopes/{scope_id}/members/{user_id}
       Returns: { status: "removed" }
       Auth: require_user_auth, caller must own scope (or be self-leave).

POST   /api/scopes/{scope_id}/unshare
       Revokes all links + removes all members in one transaction.
       Returns: { links_revoked: N, members_removed: M }
       Auth: require_user_auth, caller must own scope.
```

### 7.2 Sharee-facing — invitation inbox

```
GET    /api/me/invitations
       Returns: pending invitations for the caller's email
       Auth: require_user_auth.

POST   /api/me/invitations/{invitation_id}/accept
       Returns: MembershipResponse
       Auth: require_user_auth.

POST   /api/me/invitations/{invitation_id}/decline
       Returns: { status: "declined" }
       Auth: require_user_auth.

GET    /api/me/scopes
       Returns: { owned: ScopeResponse[], shared: ScopeResponse[] }
       Auth: require_user_auth.
       (Replaces / extends the existing `/api/scopes` listing —
        the shared subset is the new piece.)

POST   /api/scopes/{scope_id}/leave
       Returns: { status: "left" }
       Auth: require_user_auth, caller must be a member (not owner).
```

### 7.3 Anonymous share-token surface

A new dependency `require_share_token` validates the token, fetches
the `ShareLink` row, checks `revoked_at IS NULL AND
(expires_at IS NULL OR expires_at > NOW())`, returns the `scope_id`.
No `AuthContext` involvement.

```
POST   /api/share/{token}/redeem
       Returns: ShareRedeemResponse {
           scope: { id, name, slug, owner_display, owner_handle },
           skill_count: number,
           vault_locked_count: number,    -- vault items visible-but-locked
           redeem_id: UUID                -- internal cursor
       }
       Auth: require_share_token only.
       Side-effects: increments redeem_count, sets last_redeemed_at.

GET    /api/share/{token}/scope
       Returns: full scope metadata + skill index (key, version, hash) +
                vault metadata (vault names, item names, last_modified —
                NO encrypted_value)
       Auth: require_share_token only.

GET    /api/share/{token}/skills/{skill_key}/tarball
       Returns: skill tar binary stream (same content as authed path)
       Auth: require_share_token only.

POST   /api/share/{token}/upgrade
       Body: empty (Clerk JWT in Authorization header)
       Returns: MembershipResponse
       Auth: require_user_auth (Clerk JWT) + require_share_token.
       Side-effects: creates scope_memberships row,
                     joined_via='link',
                     does NOT delete the token (multiple CLI devices
                     may still be using it).
```

### 7.4 Vault resolution — gate update

```
POST   /api/vault/resolve  (existing endpoint)
       Behavior change: scope_ids_visible_to now includes shared scopes
       when the caller is Clerk-bound (or unbound CLI key). Server-side
       enforcement is purely "is the resolved scope_id in your visible
       set?" — no new auth dependency, no special share-token branch.
```

Share-token-only callers never call this endpoint. The CLI knows
whether it has a Clerk-bound credential and pre-empts: when an agent
asks to resolve `clawdi://vault/...` and the only available
credential is a share-token, the CLI errors locally with the
`sign_in_required` hint rather than round-tripping. This keeps the
server's auth model unchanged and avoids inventing a "structured 403
with body hint" pattern just for this case.

## 8. CLI Surface

### 8.1 New top-level commands

```
clawdi scope share <scope>                      # create + print link
clawdi scope share-links <scope> [--revoke ID]  # manage links
clawdi scope invite <scope> --email <e>         # send pending invite
clawdi scope invites <scope>                    # list outgoing
clawdi scope invites --cancel <id>              # cancel one
clawdi scope members <scope> [--remove <who>]   # list / remove
clawdi scope unshare <scope>                    # stop sharing entirely
clawdi scope leave <scope>                      # leave a shared scope
clawdi scope list                               # owned + shared with marker

clawdi share accept <url>                       # anonymous redeem
clawdi share list                               # list local share-tokens
clawdi share remove <scope-id>                  # remove local share

clawdi scope invites                            # pending incoming invites
                                                # (auto-runs at login)
clawdi scope invites --accept <id> | --decline <id>
```

### 8.2 Local state

```
~/.clawdi/share-tokens.json
{
  "version": 1,
  "tokens": [
    {
      "scope_id": "abc-123",
      "owner_handle": "alice",
      "token": "raw_token_string",
      "redeemed_at": "2026-05-11T14:22:00Z",
      "skill_root": "/Users/x/.claude/skills"  -- adapter-resolved
    }
  ]
}
```

File mode 0600. The daemon (`clawdi serve`) enumerates this file in
addition to its usual env-bound work to sync shared skills.

### 8.3 Auto-upgrade after sign-in

When `clawdi auth login` completes successfully and
`share-tokens.json` is non-empty, the CLI prints:

```
You have 3 pending share-tokens. Convert them to permanent memberships
in your dashboard? [Y/n]
```

If Y: batch-invoke `POST /api/share/{token}/upgrade` for each token
with the new Clerk JWT, then delete the file (or selectively delete
upgraded entries on failures).

### 8.4 Sync engine behavior

The `clawdi serve` daemon, when in **anonymous mode**
(no `CLAWDI_AUTH_TOKEN`, but `share-tokens.json` present), only does
**downstream** sync (pull skills from shared scopes; no push, no
session sync). When **Clerk-bound** (after login), it also covers
shared scope skills via the membership path. The existing SSE
subscription extends from "scopes I own" to "scopes I see"
(via `scope_ids_visible_to`).

## 9. Web Dashboard Surface

### 9.1 New routes / pages

- `/share/[token]` — landing page. Public (no Clerk gate). Server-
  side renders owner display + scope name + skill / vault counts.
  Two CTAs:
  - "Have the CLI?" → copyable `clawdi share accept <url>` block.
  - "Add to my dashboard" → Clerk sign-in gate → `POST /api/share/{token}/upgrade` → redirect to scope detail.
  - "Install the CLI" → existing install docs.
- `/scopes/[id]/sharing` — owner-only tab inside scope detail.
  - Links section: create, list, copy, revoke. Each row shows
    prefix, label, redeem count, last redeem, expires.
  - Invitations section: send by email, list pending, cancel.
  - Members section: list, remove. Counts both manual-invited and
    link-upgraded; shows `joined_via` icon.

### 9.2 Pages with shape changes

- Sidebar `Scopes` — split into "My scopes" and "Shared with me".
  Existing `/api/scopes` query becomes `/api/me/scopes` returning
  both groups.
- Scope detail page — conditional Sharing tab + Leave button based
  on `is_owner`.
- Skills list page — when filtered to a shared scope, show
  `shared from @owner` tags on rows; hide edit / delete / push
  buttons.
- Vault list page — same `shared from @owner` tags; metadata only
  on read; vault item detail page shows item name + last modified
  but no plaintext (dashboard never resolves anyway).
- `/me/invitations` (new) — incoming pending invitations.
  Surfaced as a badge in the sidebar.

### 9.3 No changes

- Session list, contribution graph, ResourcesCard — sharing is
  orthogonal and these views remain user-scoped (sessions are
  fundamentally personal).
- All hosted-tile / live-sync UI from PR #77 is untouched.

## 10. Vault Strategy

### 10.1 v1 access-control approach

The existing vault model:
- `VAULT_ENCRYPTION_KEY` is a single server-side AES-256-GCM key
  shared across all users.
- Each `VaultItem.encrypted_value` is encrypted with this global
  key plus a per-item nonce.
- `POST /api/vault/resolve` decrypts server-side and returns
  plaintext to authenticated CLI callers (`require_user_cli`).
- The cryptographic boundary is "server can decrypt anything";
  the privacy boundary is enforced at the API layer.

For v1 cross-user sharing, **we keep this same model** and add
access checks at the API layer:

- `scope_ids_visible_to` widens to include shared scopes for
  Clerk-bound users → vault list / metadata reads succeed for
  shared scopes.
- `POST /api/vault/resolve` already runs through `require_user_cli`
  which rejects share-token callers (no AuthContext). It additionally
  checks the resolved vault belongs to a scope in
  `scope_ids_visible_to(db, auth)` — same check skills already do.
- Result: viewer members can resolve, share-token holders get 403
  with a structured `sign_in_required` body.

### 10.2 What v1 deliberately does NOT do

- **Per-member envelope encryption.** A future milestone will
  introduce per-membership encrypted DEKs (a fresh per-scope
  data-encryption key, encrypted under each member's public key,
  stored per-membership). At resolve time the server hands the
  encrypted DEK to the member's CLI; the CLI decrypts locally.
  This eliminates the "server-side trust anchor" property and
  is a real cryptographic improvement, but is well-scoped enough
  to be its own milestone.

- **Vault item revocation rekey on member removal.** With v1's
  server-side decrypt model there's no key to rotate when removing
  a member; access is just denied at the API. With the future
  envelope-encryption model, removing a member should ideally
  trigger a vault rekey. Out of scope for v1; out of scope for
  the envelope-encryption milestone too unless explicitly added.

### 10.3 Why this sequencing

The user-facing UX (sharee sees vault items, signs in to resolve)
is identical under v1 and the future envelope-encryption design.
We can ship v1 with the API-gate model now and migrate the
cryptography in a transparent follow-up: members keep their
memberships, the dashboard UX doesn't change, the CLI receives
slightly different decryption metadata at resolve time. The
deferral is purely about cryptographic hardening, not about UX.

## 11. Skill Local Layout

The cloud-side uniqueness `(user_id, scope_id, skill_key)` is unchanged.
On disk, sharee CLI maps shared skills to **suffix-disambiguated**
paths so the agent's flat `<root>/*/SKILL.md` glob continues to work.

### 11.1 Rules

- **Personal scope skills**: `<adapter-skills-root>/<key>/`
  — unchanged from today.
- **Env-scope skills**: same as personal — daemon decides which
  scope's skills land in the agent's root based on
  `default_scope_id`.
- **Shared scope skills**: `<adapter-skills-root>/<key>__<owner-handle>/`
  — note the **double underscore** separator and `<owner-handle>`
  suffix.

### 11.2 `owner-handle` resolution

Computed server-side once at membership creation (or first share-token
redeem) and stored on the row (`scope_memberships.resolved_owner_handle`
or, for tokens, returned in the redeem response and cached locally).
This means the local path never changes when the owner renames.

Order of choice:

1. `kebab(users.display_name)` — e.g., "Alice Chen" → `alice-chen`.
2. Local part of `users.email` — e.g., `alice@x.com` → `alice`.
3. Append a 4-char short hash of `user.id` if (1) and (2) collide
   with another sharee's owner-handle in the same sharee's
   namespace — e.g., `alice-xy23`.

### 11.3 Examples

```
~/.claude/skills/
  git-tools/                  ← user's own personal-scope skill
  k8s-helpers/                ← user's own (env-scope today;
                                 collapsed to flat by adapter)
  git-tools__alice/           ← shared from alice (same key, no clash)
  team-stuff__bob/            ← shared from bob
  experiments__alice-xy23/    ← shared from another alice (disambiguated)
```

### 11.4 Adapter integration

Each adapter (`packages/cli/src/adapters/*.ts`) provides a single
new method:

```ts
getSharedSkillPath(key: string, ownerHandle: string): string
// e.g. claude-code → `<root>/skills/${key}__${ownerHandle}/`
```

OpenClaw and Hermes, whose layouts are richer, encode the
owner-handle into their existing structure (e.g.
`agents/<id>/skills/<key>__<owner>/`). The sync-engine uses
`getSharedSkillPath` whenever the scope is not the daemon's
default scope.

### 11.5 Conflict scenarios resolved

| Sharee has... | Then accepts... | Result on disk |
|---|---|---|
| Own `git-tools` | alice's `git-tools` | `git-tools/` + `git-tools__alice/` — coexist |
| alice's `git-tools` | another alice's `git-tools` | First keeps `git-tools__alice/`, second gets `git-tools__alice-xy23/` |
| alice's `git-tools` | alice's renamed `git-tools` | Same path (owner-handle frozen at first redeem; see § 11.6) |

### 11.6 Anonymous → membership handle drift

The owner-handle is computed server-side at two points:

- **Anonymous redeem** — returned in `ShareRedeemResponse`, cached
  in `share-tokens.json` locally.
- **Membership creation** — computed at the moment the membership
  row is inserted (invite-accept, web-redeem, or token-upgrade) and
  frozen on `scope_memberships.resolved_owner_handle`.

If an owner renames between the anonymous redeem and the CLI sign-in
that upgrades it, the local path used during the anonymous period
and the membership row's handle can differ. We accept this:
- The local skill files keep their original anonymous-time path
  (the daemon doesn't aggressively rename folders mid-life).
- The dashboard and `clawdi scope list` show the membership row's
  handle (current at upgrade time).
- A `clawdi scope refresh-handles <scope-id>` opt-in command can
  resync local paths if a user cares. Out of scope for v1 to make
  this automatic — the cosmetic difference is rare and benign.

## 12. Auth and Token Lifecycle

### 12.1 Share-link token generation

- Raw token: 32 random bytes, URL-safe base64 → 43-char string.
- Server stores `sha256(token)` (64-char hex). The raw token is
  returned **once** on `POST /api/scopes/{id}/share-links` and never
  again — owners who lose it must regenerate.
- The URL is `https://clawdi.ai/share/<raw_token>`. The token is
  the entire identifier; there's no separate link-id slug.

### 12.2 Token validation

`require_share_token`:
1. Extract token from URL path.
2. Compute `sha256`.
3. SELECT scope_share_links WHERE token_hash = $1.
4. Reject if `revoked_at IS NOT NULL` or `expires_at < NOW()`.
5. Attach `(scope_id, link_id)` to request state.

### 12.3 Upgrade flow

```
CLI on first sign-in:
  read ~/.clawdi/share-tokens.json
  for each token:
      POST /api/share/{token}/upgrade
        Authorization: Bearer <clerk_jwt>
  on 200: keep token in file (other devices still use it) but
          mark `upgraded_at` locally so future runs don't re-prompt.
  on 410 (link revoked): delete the entry locally.
```

Server-side:
```
require_user_auth (Clerk JWT) → bound user
require_share_token (path) → scope_id

INSERT scope_memberships (scope_id, user_id, role='viewer',
                          joined_via='link',
                          resolved_owner_handle=...)
  ON CONFLICT (scope_id, user_id) DO NOTHING

Return existing or new membership row.
```

### 12.4 Multiple device behavior

Each device has its own share-tokens.json. Device A and device B
running with the same raw token both consume access. When device A
signs in and upgrades, the token stays valid for device B until
device B also signs in (or owner revokes the link). Memberships
are user-bound, so both devices end up with the same membership
post-upgrade. This is the right behavior for the user's "I have
two machines" case.

### 12.5 Revocation propagation

When an owner revokes a share-link:
- Server sets `revoked_at = NOW()`.
- Next CLI sync round (or next REST call) on devices still using
  the raw token returns 410.
- CLI prints `Owner revoked this share. Removing local copy.` and
  deletes the entry from share-tokens.json + the local skill files.
- Memberships created via `joined_via='link'` are **not** affected —
  revoking a link only invalidates anonymous CLI access, not
  upgrades that already became memberships. To "block this person
  entirely" the owner must also `DELETE
  /api/scopes/{id}/members/{user_id}`.

## 13. SSE / Real-time Sync

The `/api/sync/events` SSE channel already broadcasts
`skill_changed` / `skill_deleted` / `revision_bump` per scope. The
filter today is "scopes the caller's user_id owns." It widens
naturally once `scope_ids_visible_to` returns shared scopes too —
no SSE protocol change required.

Anonymous share-token sync is **poll-based** (the daemon does a
periodic pull, not SSE). This is because:
- The SSE channel multiplexes scopes server-side via auth context;
  share-tokens are per-scope and don't have an AuthContext.
- The expected sharee experience is "skills update once a day or
  less"; polling every 5 minutes is fine.
- Adding SSE multiplexing for tokens would require a new
  per-token long-lived connection model. Defer until UX demands it.

## 14. Phasing

### v1 (this spec)

Everything described above. Single PR or a short branch of PRs
(migration → backend routes → CLI commands → web UI). No partial
shipping mid-cycle — sharing as an end-to-end feature.

### v1.1 (small follow-ups)

- Owner-facing audit log: who redeemed, who joined, who removed
  whom, with timestamps and viewer IP (privacy-considered).
- Link expiry presets in the UI (1 day / 1 week / never).
- Optional `--password <p>` on share-link create (rate-limit
  brute force; not in v1 because UX wasn't a stated need).

### v2 (separate milestones)

- Memory cross-user sharing — requires the memory subsystem to
  fully enforce `scope_id` on its read paths first.
- Editor role — viewer + write permission. Requires UX for
  "two writers, last-write-wins?" or proper merge.
- Per-member envelope encryption for vault — see § 10.2.
- Marketplace / discovery / public listing of "Featured" scopes.
- Per-resource sharing (one skill, not whole scope).

## 15. Risks and Mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Share-link brute-force discovery | Low | Medium | Tokens are 32 random bytes → 2^256 keyspace. Server logs failed redeems for anomaly detection but no rate limit in v1. |
| Token leaked publicly (e.g. into a blog post) | Medium | Medium | Owner-controlled revoke is the canonical fix. Future v1.1: link-level rate limit + redeem count alerts. |
| Sharee's anonymous CLI accumulates stale tokens | Medium | Low | `clawdi share list` exposes them; `clawdi share remove` cleans. CLI auto-removes on 410. |
| Owner-handle collision producing unintuitive `alice-xy23` paths | Low | Low | Document. Provide `clawdi scope list --verbose` showing handle origin (display name / email / fallback). |
| Migration deadlock with concurrent share operations | Very Low | Low | v1 has zero existing data; migration is DDL-only and runs in < 100ms. |
| Privacy: email-invite reveals whether an address is registered | Medium | Low-Medium | Invitation endpoint returns generic 200 regardless of registration state (the actual invite row is created only if user exists; the lookup itself is internal). Wording: "If they have a clawdi account, they'll see this in their dashboard. Otherwise, share the link instead." |
| Vault metadata leak to anonymous holder (item names) | Low | Low | Acceptable — item names are not secret. If a deployment treats item names as sensitive, owner shouldn't share that scope. Document. |
| Membership row drift (`resolved_owner_handle` outdated if user renames) | Low | Low | Acceptable by design — local path stability outweighs handle freshness. Add `clawdi scope list --refresh` to recompute if a user wants. |
| Web "Add to my dashboard" race (user A clicks while owner revokes) | Low | Low | Server transaction: SELECT link FOR UPDATE → check revoked → INSERT membership → commit. Either A becomes member or sees "link revoked." |

## 16. Testing Strategy

### Backend (pytest)

- Unit: `scope_ids_visible_to` returns owned ∪ shared.
- Endpoint coverage for every new route (happy + auth + cross-tenant + idempotency).
- Token redemption: valid / revoked / expired / unknown / cross-scope reuse.
- Token upgrade race: two devices upgrade same token simultaneously; only one membership row created (ON CONFLICT DO NOTHING).
- Vault resolve: viewer member OK, share-token gets 403 with structured body.
- Cascade: deleting a scope removes all memberships + invitations + links + cascades correctly.
- Cascade: deleting a user removes their memberships (incoming and outgoing).
- Invitation: email lookup found / not found behavior matches privacy posture.
- `unshare` atomicity: all-or-nothing rollback on any sub-failure.

### CLI (vitest / bun test)

- `share-tokens.json` read / write / migration from v0 (no file → empty).
- Auto-upgrade prompt path (mocked stdin Y / n / no-tokens).
- `share remove` cleans local skill files for the scope.
- Adapter-specific `getSharedSkillPath` produces correct path for each agent.

### Web (Playwright or component tests)

- Landing page renders both anonymous CTAs (without Clerk session) and registered CTA (with).
- Owner Sharing tab: link create / copy / revoke; invite send / cancel; member list.
- Sharee scope view: read-only affordances; Leave button works.
- Pending invite accept / decline.

### End-to-end (manual or scripted)

- Owner shares → anonymous user accepts via CLI → uses skill in agent → tries vault → gets prompt → signs in → membership upgrades → vault resolves.
- Owner email-invites registered user → user accepts in dashboard → member.
- Owner revokes → anonymous CLI gets cleaned up gracefully → upgraded member unaffected.

## 17. Open Questions

None at spec time. Any discovered during implementation should be
appended here with date + resolution.

## 18. References

- `docs/plans/env-scoped-skills.md` — original scope design;
  reserves `scope_memberships` and notes "Vault encryption rework
  for shared scopes" as a future milestone.
- `backend/app/core/scope.py` — `scope_ids_visible_to` and
  `resolve_default_write_scope`.
- `backend/app/models/scope.py` — `Scope` model; reserves `kind`
  CHECK constraint for future extension (this spec does NOT take
  the `'shared'` kind slot).
- PR #77 (`feat: Phase 4a live-sync foundations`) — establishes
  the admin endpoint pattern this spec sometimes references as
  precedent for `require_*` dependencies and migration safety
  patterns.
