# Cross-User Scope Sharing — Design Spec (v1)

> **Historical / superseded.** This spec describes the v1 membership-based
> sharing surface that shipped earlier on `feat/scope-sharing`. The v2
> evolution layers `ScopeMount` (composition) on top of v1's
> `ScopeMembership` (capability). See
> [`2026-05-11-scope-mount-spec.md`](2026-05-11-scope-mount-spec.md)
> for the current shipping spec.
>
> The data model, share-link / invitation flows, and read-path
> safety properties from this v1 spec all remain accurate — v2 keeps
> them and adds a new layer on top.

**Status**: Shipped as v1; layered into v2 mount model on follow-up.
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
- Server-side `scope_ids_visible_to` extended so shared scopes
  flow into the **skill** and **vault** read paths. (Memory is out
  of scope for v1 — see Non-Goals — and the memory read paths
  don't currently use `scope_ids_visible_to` anyway. Touching
  memory sharing is a separate milestone.)
- Skill and vault read paths converted from "filter by
  `user_id == auth.user_id` AND `scope_id IN visible`" to "filter
  by `scope_id IN visible` only". The double-AND defeated shared
  scope visibility because the sharee's `auth.user_id` doesn't
  match the owner's `Skill.user_id`. See § 5.3.
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
| Sign up later | Sign up at `clawdi.ai` (Clerk hosted UI) | After web sign-up, `clawdi auth login` → CLI detects local share-tokens → interactive prompt `Convert N pending shares to memberships? [Y/n]` → server creates memberships → CLI marks each token with `upgraded_at` (kept in file so other devices keep working); only revoked tokens are physically deleted. See § 8.3. |

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
| **Pending invitation collides with token redemption** | Bob has a pending invitation AND clicks Alice's share link, then signs in to upgrade. Result: membership created, pending invitation **auto-deleted** in the same transaction (avoids ghost state where Alice sees Bob as both a member and a pending invitee). Symmetric: accepting an invitation also deletes any other pending invitation for the same (scope_id, invitee_user_id). |
| **Invitee changes email after invitation** | Invitation row stores `invitee_user_id` (FK to users) at creation, not just the email string. The invitee's `/api/me/invitations` lookup matches by `invitee_user_id == auth.user_id`, so a Clerk-side email change does not lose the invite. The original `invitee_email` is preserved as historical context only. |
| Owner removes a member, member redeems an OLD anonymous token | Token is still valid (token != membership). To **fully** block the person, the owner must remove the member AND revoke any share-link they may have redeemed (then rotate to a new link for other intended recipients). The "Remove member" UI surfaces this hint explicitly. |
| Anonymous sharee on device A signs in on device B | Device A keeps using its share-tokens until device A also signs in; device B's memberships are independent of device A's tokens |
| Pending invitation, owner removes the invite, invitee tries to accept | 410 Gone; invite no longer exists |
| **Owner has no `name` (display name), tries to share** | Server returns 409 `display_name_required`. The `users.name` column is the user-visible display name; if it's NULL the handle would fall back to the email local-part, leaking the email address to recipients. Forcing the owner to set `name` first is the cheapest mitigation. |

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

**Critical caveat — read paths must drop the `user_id` filter.**
The current implementation of `/api/skills`, `/api/skills/{key}`,
`/api/vault`, `/api/vault/resolve`, and several others combines
`scope_id IN visible_scope_ids` with `Skill.user_id == auth.user_id`
(or the Vault equivalent). For owned scopes this is harmless and
in fact a useful index hint, but for a shared scope the
**owner's** `Skill.user_id` does not match the **sharee's**
`auth.user_id`. The AND filter silently drops every shared row,
defeating the whole feature.

The fix is mechanical: every read path that intersects scope
visibility with user_id must drop the user_id clause. After the
change, `scope_id IN scope_ids_visible_to(auth)` is the SOLE
tenancy filter on read paths. Two implications:

1. The visible_scope_ids set IS the access boundary. Audit it
   carefully — anything in that set means the caller may read
   every row under it.
2. **Write paths still filter by `user_id == auth.user_id`.**
   Viewer membership grants read access, not write — only the
   owner can mutate. Today's write routes (skill push, vault
   create / delete / put) keep their existing user_id
   ownership filter; only read routes change.

A separate validator, `validate_scope_for_caller_read` (split
from the existing `validate_scope_for_caller` which conflates
read + write), reflects this in the route layer. Routes that
mutate keep calling the owner-only validator; routes that just
read use the new variant which accepts any membership.

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
-- on accept; row is deleted on accept / decline / cancel / any
-- membership-create path for the same (scope_id, invitee_user_id).
CREATE TABLE scope_invitations (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_id         UUID NOT NULL
                     REFERENCES scopes(id) ON DELETE CASCADE,
    -- Invitee MUST be a registered user at invitation time
    -- (unregistered emails redirect to "send a share link instead").
    -- Storing the user FK + the as-typed email lets us:
    --   1. follow Clerk-side email changes without losing the invite
    --      (lookup by user_id, not by email),
    --   2. preserve the original recipient string for owner UI.
    invitee_user_id  UUID NOT NULL
                     REFERENCES users(id) ON DELETE CASCADE,
    invitee_email    VARCHAR(320) NOT NULL,  -- as typed, historical
    invited_by       UUID NOT NULL
                     REFERENCES users(id) ON DELETE CASCADE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (scope_id, invitee_user_id)
);

CREATE INDEX scope_invitations_invitee_user_id_idx
    ON scope_invitations(invitee_user_id);

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
    -- Owner handle (kebab display name) frozen at link creation time.
    -- Returned to anonymous redeemers AND copied to scope_memberships
    -- on upgrade, so the sharee's local skill path
    -- (`<key>__<handle>/`) stays consistent across the
    -- anonymous → membership transition even if the owner renames
    -- between create + redeem + upgrade. See § 11.
    resolved_owner_handle VARCHAR(64) NOT NULL,
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
is **`require_user_auth_unbound`** — a new dependency that wraps
`require_user_auth` and additionally rejects env-bound api_keys.

Why a new dep: the existing `require_user_auth` only rejects
NARROWLY-scoped api_keys; it lets env-bound full-scope deploy keys
through (those are used by hosted pods and are expected to "act like
the user's laptop"). But sharing operations are
**account-management surface**: a leaked hosted-pod credential
should NOT be able to mint share-links into the user's scopes
behind the user's back, manage members, or upgrade shares to
memberships under a different identity. The blast-radius boundary
that PR #77 established for hosted pods (env-bound key → single
scope visibility) is explicit; sharing endpoints respect the same
spirit by rejecting env-bound calls entirely.

Definition (added to `app/core/auth.py`):

```python
async def require_user_auth_unbound(
    auth: AuthContext = Depends(require_user_auth),
) -> AuthContext:
    """Require Clerk JWT OR fully-unbound CLI api_key.
    Rejects env-bound deploy keys (api_key.environment_id is not None)
    in addition to the narrowly-scoped rejection require_user_auth
    already does."""
    if auth.is_cli and auth.api_key is not None and auth.api_key.environment_id is not None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "sharing operations require user-level auth (env-bound deploy "
            "keys cannot manage sharing)",
        )
    return auth
```

Every sharing endpoint in § 7.1–§ 7.3 below uses
`require_user_auth_unbound` unless explicitly noted otherwise.
Read-only `/api/me/scopes` is the exception — it returns the
union of owned + shared scopes; an env-bound caller seeing only
its env's scope (per the existing `scope_ids_visible_to` filter)
is correct behavior, and adding `_unbound` there would surprise
hosted-pod callers that just want to know their visible scopes.

The vault resolve endpoint (`POST /api/vault/resolve`) keeps its
existing `require_user_cli` gate. That dep already explicitly
allows env-bound keys for the "hosted pod = user's laptop"
contract — vault resolve in a shared scope flows through the
existing logic without further restriction.

### 7.1 Scope sharing — owner-facing

```
POST   /api/scopes/{scope_id}/share-links
       Body: { label?: string, expires_at?: ISO8601 }
       Returns: { id, raw_token, url, prefix, owner_handle,
                  created_at, expires_at }
       Auth: require_user_auth, caller must own scope.
       Notes:
         - raw_token returned ONCE, server stores hash only.
         - Server resolves and FREEZES `resolved_owner_handle` on
           the row at create time (see § 11). Returned in the
           response so the owner can preview what sharees will see.
         - Caller MUST have `users.name` (display name) set. If
           NULL, 409 `display_name_required` with a hint to update
           the profile first. Rationale in § 4.5 edge cases.

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
       Behavior:
         - Lookup `users` by lower(email). `users.email` is NOT unique
           in the schema (production may carry duplicates from snapshot
           imports — see `_auth_via_clerk_jwt` ambiguity handling).
           Count matching rows:
             * 0 rows → 404 `user_not_found` (invitee not registered;
                        UI suggests sending a share link instead)
             * 1 row  → invite that user (the common case)
             * ≥2 rows → 409 `ambiguous_email`. We deliberately refuse
                         to pick one — silently inviting the wrong
                         account would be a privacy break. The owner
                         is told to send a share link to the intended
                         recipient and have them join via redeem
                         (which carries explicit user identity).
         - On the 1-row path, store BOTH `invitee_user_id` (FK to
           users.id) and `invitee_email` (as typed). User-id is the
           durable identity; email is historical context only.
         - Uniqueness is `(scope_id, invitee_user_id)` — re-inviting
           the same person by a different email alias still 409s.
       Errors:
         400 already_owner    — email maps to scope owner
         404 user_not_found   — no registered user
         409 ambiguous_email  — multiple users with that email
         409 already_member   — invitee already a member
         409 already_invited  — pending invite exists

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
       Transaction:
         1. Lookup invitation, verify `invitee_user_id == auth.user_id`.
            (Email-string match is NOT used — see edge case in § 4.5.)
         2. Create scope_memberships row, joined_via='invite'.
         3. Delete this invitation row.
         4. Delete any OTHER pending scope_invitations for the same
            (scope_id, invitee_user_id) — defense against operator
            error duplicating invites by alternate email.

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
GET    /api/share/{token}/preview
       Returns: ShareRedeemResponse (same shape as /redeem below)
       Auth: require_share_token only.
       Side-effects: NONE. Pure read for the public landing page,
       link-unfurlers, and other "what is this?" callers. The
       redeem-count statistic stays accurate; SSR + crawlers can
       hit this freely.

POST   /api/share/{token}/redeem
       Returns: ShareRedeemResponse {
           scope_id: string,
           scope_name: string,
           owner_display: string,
           owner_handle: string,         -- copied from share-link's frozen handle
           skill_count: number,
           vault_count: number,          -- total vault items in scope
           vault_locked: bool            -- always true for token-only access in v1
       }
       Auth: require_share_token only.
       Side-effects: increments redeem_count, sets last_redeemed_at.
       This endpoint is **side-effecting** — call ONLY for
       anonymous CLI accepts (`clawdi share accept` on a machine
       without a CLI api_key). Anything that just previews
       (landing page, link-unfurler, page refresh) uses GET
       `/preview` above; logged-in-already accepts (web "Add to
       my dashboard" + CLI accept when authed) go straight to
       POST `/upgrade` below and DO NOT touch `redeem_count`.

       `redeem_count` semantics: "anonymous CLI accepts only."
       For "how many people actually joined" use the member list
       on the scope. The Sharing tab surfaces both numbers
       distinctly. This avoids the "anonymous redeem then later
       upgrade" sharee being double-counted under one identity.

GET    /api/share/{token}/scope
       Returns: full scope metadata + skill index (key, version, hash) +
                vault metadata (vault names, item names, last_modified —
                NO encrypted_value)
       Auth: require_share_token only.

GET    /api/share/{token}/skills/{skill_key}/tarball
       Returns: skill tar binary stream (same content as authed path)
       Auth: require_share_token only.

POST   /api/share/{token}/upgrade
       Body: empty (caller credential in Authorization header)
       Returns: MembershipResponse
       Auth: require_user_auth_unbound + require_share_token.
       The user credential MAY be either a Clerk JWT (web "Add to
       my dashboard") OR an unbound CLI api_key (CLI auto-upgrade
       after `clawdi auth login`). Env-bound deploy keys are
       rejected (hosted pod must not mint memberships on the
       user's behalf — see § 7 intro for the `_unbound` dep
       rationale).
       Transaction:
         1. Create scope_memberships row with joined_via='link' and
            resolved_owner_handle COPIED from the share-link's frozen
            handle (so anonymous + post-upgrade paths agree).
            Idempotent on (scope_id, user_id) — return existing.
         2. Delete any pending scope_invitations for the same
            (scope_id, invitee_user_id == auth.user_id). Covers the
            "Bob got an email invite AND clicked the link" path
            described in § 4.5.
         3. Do NOT delete the share-token row; multiple CLI devices
            may still be using it on the user's other machines.
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
with the now-stored CLI api_key (the same credential `clawdi auth
login` saved — there is no Clerk JWT in CLI scope). Per token:

- **200** → mark the entry locally with `upgraded_at = now()`.
  Keep the token in `share-tokens.json` — another device of the
  same user may still be using it, and revoking it client-side
  would re-prompt the user to redeem from scratch on next sync.
  Future runs of the auto-upgrade flow on this device check
  `upgraded_at` and skip already-upgraded entries to avoid
  re-prompting.
- **410** → the link was revoked between redeem and login.
  Delete the entry locally; the membership doesn't exist.
- Other status / network failure → leave the entry untouched
  and surface the error. Next login retry will re-attempt.

### 8.4 Sync engine behavior

The `clawdi serve` daemon, when in **anonymous mode**
(no `CLAWDI_AUTH_TOKEN`, but `share-tokens.json` present), only does
**downstream** sync (pull skills from shared scopes; no push, no
session sync). When **Clerk-bound** (after login), it also covers
shared scope skills via the membership path. The existing SSE
subscription extends from "scopes I own" to "scopes I see"
(via `scope_ids_visible_to`).

**Polling cadence for share-token scopes**:
- Default: every **5 minutes**. The daemon hits
  `GET /api/share/{token}/scope` once per share-token per cycle to
  pick up content-hash deltas, then pulls changed tarballs.
- Overridable via env var `CLAWDI_SHARED_POLL_SECONDS` (integer
  seconds; minimum 60 to avoid pathological loads).
- The 5-minute default matches user expectations for share-link
  flows ("I just got the link, I want it usable now, but real-time
  updates from someone else's scope can wait a few minutes").
- Clerk-bound mode uses the existing SSE channel and gets near-
  real-time updates for shared scopes too (see § 13).

**Daemon auth modes (three distinct cases):**

| Mode | Trigger | share-tokens.json handling |
|---|---|---|
| `anonymous` | No `CLAWDI_AUTH_TOKEN` | Authoritative — every token in the file is synced each cycle. |
| `user-interactive` | `CLAWDI_AUTH_TOKEN` set, api_key has `environment_id IS NULL` (the "laptop after `clawdi auth login`" case) | Tokens with `upgraded_at` set are SKIPPED — membership path now owns those scopes via `scope_ids_visible_to`. Non-upgraded tokens are still processed (auto-upgrade prompt may not have completed yet, or user declined). |
| `env-bound` | `CLAWDI_AUTH_TOKEN` set, api_key has `environment_id` (hosted-pod deploy key) | The daemon **ignores `share-tokens.json` entirely**. Hosted pods are not the surface where users redeem personal share-links — the pod's blast radius is scope-restricted by design (PR #77 contract), and forcing it to process share-tokens would expand that radius into other users' shared scopes. If a misconfigured pod somehow has the file, the daemon silently treats it as not-present. |

**Mixed mode** — most commonly the `user-interactive` transition
right after sign-in: laptop daemon has `share-tokens.json` AND a
freshly-issued api_key. Without the upgraded-token skip, the
daemon would double-sync each upgraded scope (one path per
flow), writing to the same `<key>__<owner-handle>` folder twice
per cycle. The skip flag (`token.upgraded_at`) is set by the
post-login auto-upgrade flow (§ 8.3) once the server returns 200
on `POST /api/share/{token}/upgrade`.

If the user-interactive daemon later loses its CLI api_key (file
removed, revoked, expired), the next cycle drops to `anonymous`
and tokens flip back to authoritative — the user's content keeps
syncing from whichever auth still works.

Tests in plan Phase E.5 / E.6 cover the no-duplicate-folder
invariant explicitly for the user-interactive transition.

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

### 10.4 Skill content disclosure — the OTHER channel

Vault is the headline secret channel — and the only one with an
explicit gate. **Skills are not encrypted, not gated by membership,
and a share-token caller downloads them in full**. Files inside a
skill tar (`SKILL.md`, scripts, attached binaries, configs) are
returned verbatim through `GET /api/share/{token}/skills/{key}/tarball`.

This matters because in practice users frequently embed secrets
directly inside skill files: `OPENAI_API_KEY=sk-...` in a shell
script, a webhook URL with an embedded token in a config snippet, a
`.env` file copied into the skill folder. The vault gate does
**not** protect these — anyone with the share link can read them.

v1 surfaces the risk twice along the owner path:

1. **Web Sharing tab** — generating a share link opens a confirmation
   modal:

   > "Anyone with this link can download the full content of every
   > skill in this scope, including any text or files they contain.
   > Make sure none of your skills contain API keys, passwords, or
   > other secrets — use vault references (`clawdi://vault/...`)
   > inside skills instead.
   >
   > [Cancel] [I understand, generate link]"

2. **CLI** — `clawdi scope share` prompts before generating:

   > "This will create a share link giving anyone full read access to
   > the {N} skill(s) in scope '{name}'. Continue? [y/N] "

Owners who DO want to share skills that reference secrets should
move the secrets into vault (one-time refactor) and use
`clawdi://vault/...` placeholders inside the skill content — the
vault gate then protects the actual values while the skill structure
remains shareable.

v2 (deferred): an opt-in **best-effort secret scanner** at
`clawdi push` time (and again at share-link create time) that
matches high-confidence patterns (`AKIA[0-9A-Z]{16}` for AWS,
`sk-[a-zA-Z0-9]{20,}` for OpenAI-style, hex blobs over a threshold,
etc.) and blocks the operation with the actual matched line. We
defer to v2 because false positives in an automated check have to
land in the owner UX as overridable warnings — that's its own
small design problem worth its own milestone.

**Snapshot semantics + TOCTOU caveat.** Share links **do not
snapshot** skill content at the link's creation time — they grant
access to whichever skill bytes are CURRENTLY in the file store at
the moment the sharee fetches the tarball. Concretely, when a
sharee calls `GET /api/share/{token}/skills/{key}/tarball`, the
server looks up the live `Skill.file_key` for that skill and
streams that exact tar back. This means:

- An owner who hardcodes a secret, pushes the skill, generates a
  share link, then later edits the skill to remove the secret has
  **not retroactively hidden the secret** — the share link still
  serves the live row, but a fast adversary who downloaded the
  old version before the owner's re-push completed would already
  have the secret. There is no "rewind" guarantee.
- The right mental model is "this link gives access to live
  content for as long as I don't revoke." Owners worried about
  past secret exposure should: (a) revoke the link, (b) push the
  cleaned skill, (c) re-rotate the underlying credential
  out-of-band (because anyone who already downloaded the old tar
  still has it locally), and (d) generate a fresh link after the
  push lands.
- v2 best-effort scanner would catch this **before** the bad
  push lands, which is the only durable fix.

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
  suffix. (The owner-handle is `<kebab-name>-<user-id-prefix>`,
  see § 11.2; two shared scopes from the same owner DO share the
  same suffix.)

The per-scope path conflict — same owner, two shared scopes —
deserves a closer look. If alice shares scopes A and B with bob,
both scopes' skills land in folders named `<key>__alice-a3b4/`
(differentiated only by `<key>`). This works for distinct skill
keys (A's `git-tools` vs B's `monitoring`). But what about
**cleanup**: when bob revokes one of those scopes locally, naive
suffix-match cleanup would erase folders from both scopes since
they share the suffix. v1 mitigates by **only deleting folders
whose skill key was in the revoked scope** (server returns the
last-known skill list as part of the token's payload; CLI
remembers it locally for cleanup purposes). The implementation
tracks `last_seen_skill_keys` per token in `share-tokens.json`.
See plan E.5 task for the data model.

### 11.2 `owner-handle` resolution

`owner-handle` is a **stable global identifier** for an owner,
derived deterministically from their identity. It is computed
server-side at share-link creation (or invitation accept time)
and stored on the originating row so the value never drifts.

**Definition:**

```
owner_handle = kebab(users.name) + "-" + users.id.hex[:4]
```

(`users.name` is the user-visible display name column on the existing
`users` table — the codebase does NOT have a separate
`display_name` field. The spec uses "display name" as the
human-readable concept; the SQL column is `name`.)

Examples:
- `Alice Chen` (id `a3b4c5d6-...`) → `alice-chen-a3b4`
- `Alice Chen` (id `f1e2d3c4-...`) → `alice-chen-f1e2`
- `Bob` (id `01020304-...`) → `bob-0102`

The 4-hex-char user_id suffix is **always appended**. Rationale:

- The suffix makes handles **practically unique** per owner for
  typical use. A sharee who follows two different "Alice"s
  almost always sees `alice-a3b4` and `alice-f1e2` side-by-side
  without any local collision logic.
- Frozen at server side, no per-sharee context needed at the
  freeze point. The share-link create endpoint doesn't know who
  will redeem, so a fixed-shape handle is the only thing it can
  freeze that survives across the anonymous → membership transition.
- 16^4 = 65 536 distinct suffixes per first-component, so two
  owners with the same `users.name` collide on handle with
  probability ~1/65k. v1 **accepts the cosmetic clash** when it
  happens: the sharee's local `git-tools__alice-a3b4/` folder
  silently overwrites between the two owners' content on next
  sync — both legitimately appear as `alice-a3b4` on the server.
  This is a known limitation; v2 can move to a longer suffix
  (e.g. hex[:8]) or add a uniqueness probe at link create.
- **No DB-level uniqueness constraint** on
  `scope_share_links.resolved_owner_handle` /
  `scope_memberships.resolved_owner_handle` — we explicitly want
  multiple links of the same owner to share a handle (they DO
  belong to the same person). Cross-owner clashes are accepted
  per the above.
- The suffix is human-readable enough not to look like a UUID
  vomit. Sharees reading their own folder list see `alice-a3b4`
  and recognize "this is from someone named Alice."

**Display name required.** As noted in § 4.5, the create-share-link
endpoint rejects callers with empty `users.name`
(409 `display_name_required`). Without a name we'd be
left with email-local-part (which leaks PII) or a pure UUID
fragment (unfriendly), so we just push owners to set their name
first. This is a small one-time friction for what's currently
the v1 sharing entry path.

**Where it's stored** (frozen at the moment listed):

- **Share-link path**: at `POST /api/scopes/{id}/share-links` →
  `scope_share_links.resolved_owner_handle`. Anonymous redeems
  return this value. Upgrade to membership COPIES this value to
  `scope_memberships.resolved_owner_handle`.
- **Email-invite path**: at `POST /api/me/invitations/{id}/accept` →
  `scope_memberships.resolved_owner_handle`. Computed at accept
  time from the (now current) owner state. There's no anonymous
  transit in this path.

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
| alice's `git-tools` | alice's renamed `git-tools` | Same path (owner-handle frozen at share-link creation; § 11.6) |

### 11.6 Why the anonymous and post-upgrade paths agree

A previous draft of this spec computed `owner-handle` separately at
the anonymous-redeem and at the membership-upgrade moments. That
created a drift risk: if the owner renamed between the two events,
the sharee's local skill folder (named from the anonymous handle)
and the dashboard / `clawdi scope list` rendering (from the
membership handle) would disagree.

This design freezes the handle ONCE, at share-link creation, on
`scope_share_links.resolved_owner_handle`. Every downstream
consumer reads it from there:

- Anonymous `POST /api/share/{token}/redeem` returns the frozen
  handle in `ShareRedeemResponse.owner_handle`.
- Anonymous `GET /api/share/{token}/scope` returns the same value.
- `POST /api/share/{token}/upgrade` COPIES it to
  `scope_memberships.resolved_owner_handle`.
- The Web dashboard's "Shared with me" list reads it from the
  membership row, which contains the same value.

So a sharee's local `git-tools__alice/` folder, their CLI's `clawdi
scope list` output, and the Web sidebar's entry all stay in sync —
even if alice renames between accept and upgrade.

The email-invite path doesn't go through a share-link, so it freezes
the handle on `scope_memberships.resolved_owner_handle` at accept
time. That single freeze point is sufficient — there's no
anonymous transit in this path to drift away from.

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
        Authorization: Bearer <cli_api_key>   # the one just persisted
                                              # by `clawdi auth login`
  on 200: keep token in file (other devices still use it) but
          mark `upgraded_at` locally so future runs don't re-prompt.
  on 410 (link revoked or expired, or scope deleted): delete the
          entry locally.
```

Server-side:
```
require_user_auth → bound user (Clerk JWT OR unbound CLI api_key)
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

### 12.5 Revocation — two independent levers

Access via share-link and access via membership are **independent**.
This is by design (a token has no user identity, a membership has
no token), but it surfaces a subtle UX point: neither revoke
action on its own fully cuts off a determined recipient.

**Revoking a share-link** (`DELETE /api/scopes/{id}/share-links/{link_id}`):
- Server sets `revoked_at = NOW()` on the link.
- Anonymous CLI holders using the token: next sync returns 410;
  CLI prints `Owner revoked this share` and deletes the entry from
  `share-tokens.json` plus local skill files.
- Members who already upgraded via this link: **unaffected**. Their
  `scope_memberships` row stays; their dashboard and CLI keep
  working.

**Owner deletes the scope** (different from revoke):
- The scope row goes; `scope_share_links`, `scope_memberships`,
  `scope_invitations` rows all cascade-delete via the existing FK
  chains.
- Anonymous CLI's next request to `/api/share/{token}/...` hits
  `require_share_token` which now finds no row → returns **404**
  (not 410). CLI surfaces a distinct message
  (`Share is no longer available (the scope may have been deleted).
  Cleaning up local copy.`) and deletes the local entry. The
  404-vs-410 distinction lets the sharee tell the difference
  between "narrowly revoked" and "scope-wide gone."
- Members who upgraded via this scope: their memberships are also
  cascaded away. Dashboard "Shared with me" no longer lists the
  scope; CLI's next `clawdi scope list` reflects the change.

**Removing a member** (`DELETE /api/scopes/{id}/members/{user_id}`):
- Server deletes the row.
- That user's Clerk-authenticated read paths (via
  `scope_ids_visible_to`) lose visibility immediately.
- BUT if the same person still has a valid share-link's raw token
  on disk, they can keep doing anonymous reads through the
  `/api/share/{token}/...` surface — the token never knew their
  identity in the first place.

**Fully blocking one specific person** therefore requires two acts:
- Remove the membership row.
- Revoke EVERY share-link they may have redeemed (and rotate new
  links for the recipients you still trust).

The Web "Remove member" confirmation surfaces this asymmetry:

> "Removing {member} stops their dashboard access immediately. If
> they used a share link to join, they can still pull skills using
> that link until you revoke it. Revoke active share links too?
> [Just remove] [Remove + revoke all links]"

The "Remove + revoke all links" path revokes every non-revoked
share-link on the scope in the same transaction and creates a
fresh link the owner can re-share with the people they kept.

The CLI's `clawdi scope members --remove <id>` accepts a
`--revoke-links` flag with the same semantics.

## 13. SSE / Real-time Sync

The `/api/sync/events` SSE channel today broadcasts
`skill_changed` / `skill_deleted` / `revision_bump` per scope to
authenticated callers. The implementation filters by the caller's
visible scope set; making it work for shared scopes is the same
one-line extension as the read paths (use
`scope_ids_visible_to`).

**Mid-connection membership changes**: the SSE handler re-fetches
its visible scope set on a refresh interval (~30 s in
`routes/sync.py`). When a fresh membership row is created during
an active SSE connection (sharee accepts an invite while connected),
events for the newly-shared scope start flowing **at most 30 s
later**, or immediately on the next SSE reconnect (whichever
fires first). This delay is acceptable for v1; if real-time
membership effect is needed, server-push the membership change to
the SSE channel as a `scope_membership_changed` event in v1.1.

**What SSE covers for shared scopes in v1:**
- Skill events (`skill_changed`, `skill_deleted`, `revision_bump`)
  — yes. A viewer member's CLI gets notified the same way the
  owner does, and pulls the updated skill immediately.
- Vault events — **no**. Vault changes are NOT pushed over SSE in
  v1 (this is true today even for owners — vault doesn't currently
  use the SSE protocol). Vault metadata visible to members refreshes
  on the next periodic poll. If vault freshness needs SSE, that's a
  follow-up extending the protocol; sharing is not the right place
  to introduce it.

**Anonymous share-token holders DON'T use SSE.** The SSE channel
requires `AuthContext`; token callers don't have one. They poll
`GET /api/share/{token}/scope` periodically (see § 8.4) and pull
deltas. Rationale:

- SSE multiplexes scopes server-side via auth context;
  share-tokens are per-scope and don't have an AuthContext.
- The typical sharee profile is "agent picks up latest on next
  invocation," not "see edits in real time."
- A per-token long-lived SSE connection model would be a meaningful
  protocol change. Defer until UX demands it.

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
- **Per-link vault-metadata toggle.** Today every share-link
  exposes vault names + item names + last_modified to anonymous
  redeemers (§ 7.3 `GET /api/share/{token}/scope` returns vault
  metadata always). v1 owner-facing copy on the Sharing tab
  explicitly tells the owner this — but doesn't give them a knob
  to suppress it. v1.1 can add a `include_vault_metadata: bool`
  field on share-link create (default true for backwards-compat
  with v1 links); when false, the redeem + scope-index responses
  omit the vaults array entirely and the sharee CLI shows "vaults
  hidden by owner."

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
| **Skill content carries hardcoded secrets** | Medium | **High** | Owner flow now has explicit confirmation gates in both CLI (`clawdi scope share` prompt) and Web (Sharing-tab modal). Docs and the gate copy push the vault-reference pattern (`clawdi://vault/...`) as the right way to share skills that touch secrets. § 10.4 spells out the failure mode + workarounds. v2 best-effort secret scanner deferred. |
| **Member-removal asymmetry — old share-token still works** | Medium | Medium | § 12.5 documents the two-lever model. "Remove member" UI offers "+ revoke all share-links" combined action (single transaction); CLI offers `--revoke-links` flag on `clawdi scope members --remove`. The wording on the confirm dialog explicitly tells the operator that link-based access survives a member-only removal. |
| **Pending invite + token-upgrade ghost state** | Medium | Low-Medium | Both the invite-accept and the token-upgrade transactions delete any other pending `scope_invitations` for the same `(scope_id, invitee_user_id)`. Owner dashboard never simultaneously shows "Bob is a member" and "Bob has a pending invitation." |
| **Invitee changes email after invitation** | Medium | Low | Invitations store `invitee_user_id` (FK to users) not just the email string. Lookup by user_id is stable across Clerk-side email rotations. The historical email is kept for owner-side display only. |
| **Owner-handle drift between anonymous and post-upgrade paths** | — | — | Eliminated by design. Handle is frozen once at `scope_share_links` creation; all downstream consumers (anonymous redeem response, membership row, dashboard render) read the same value. § 11.6. |
| Share-link brute-force discovery | Low | Medium | Tokens are 32 random bytes → 2^256 keyspace. Server logs failed redeems for anomaly detection but no rate limit in v1. |
| Token leaked publicly (e.g. into a blog post) | Medium | Medium | Owner-controlled revoke is the canonical fix. Future v1.1: link-level rate limit + redeem count alerts. |
| Sharee's anonymous CLI accumulates stale tokens | Medium | Low | `clawdi share list` exposes them; `clawdi share remove` cleans. CLI auto-removes on 410. |
| Owner-handle collision producing unintuitive `alice-xy23` paths | Low | Low | Document. `clawdi scope list --verbose` shows handle origin (display name / email / fallback). |
| Migration deadlock with concurrent share operations | Very Low | Low | v1 has zero existing data; migration is DDL-only and runs in < 100ms. |
| Privacy: email-invite reveals whether an address is registered | Medium | Low-Medium | Invitation endpoint surfaces a 404 `user_not_found` with copy that pushes "share link instead" — this does leak existence to the OWNER but not to the world. Worth the UX clarity over a generic 200; the owner is already trusted with the invitation surface. |
| Vault metadata leak to anonymous holder (item names) | Low | Low | Acceptable — item names are not secret. If a deployment treats item names as sensitive, owner shouldn't share that scope. § 10.4 covers the analogous skill-content concern. |
| Web "Add to my dashboard" race (user A clicks while owner revokes) | Low | Low | Server transaction: SELECT link FOR UPDATE → check revoked → INSERT membership → commit. Either A becomes member or sees "link revoked." |
| Bandwidth abuse via leaked share-link (anonymous holder repeatedly pulls 100MB skill tar) | Low | Low | v1: no rate limit (consistent with no-rate-limit posture overall). Mitigated by owner revoke. v1.1 can add per-link per-IP throttle if it shows up in metrics. |

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

## 17. Resolved design decisions surfaced during review

Several borderline cases came up across multiple review rounds.
They aren't open in the "needs more work" sense, but documenting
the chosen behavior here so implementation doesn't relitigate.

### 17.1 Invitee-account deletion cascades silently

`scope_invitations.invitee_user_id` has `ON DELETE CASCADE` (the
schema is in § 6.1). When a Clerk webhook deletes a user, every
pending invitation TO that user disappears from the owner's
dashboard without a notification. Acceptable for v1 — the
underlying problem ("you can't invite a non-existent account") is
self-evident from context, and a notification surface would be
its own design. v1.1 may add a `status='invitee_deleted'` row
that lingers for owner visibility.

### 17.2 Tarball 404 disambiguation — single skill vs whole scope

`GET /api/share/{token}/skills/{key}/tarball` can return 404 for
two reasons:
- the entire share is gone (link revoked / scope deleted /
  token-hash mismatch) — caller should clean up everything
- this **single** skill has no `file_key` (owner created it via
  dashboard without ever pushing files) — caller should keep
  going and try the next skill

The server distinguishes these with a header:

```
X-Share-Reason: token_invalid   → terminal; clean up entire scope
X-Share-Reason: scope_gone      → terminal; clean up entire scope
X-Share-Reason: skill_no_file   → single-skill skip; continue with next
```

CLI parses `X-Share-Reason` on every 404/410 response and routes
accordingly. Missing header is treated conservatively as
terminal cleanup (default to safe).

### 17.3 CSRF posture for sharing endpoints

All sharing endpoints accept `Authorization: Bearer <token>` only;
none accepts a cookie session. CSRF (which is a cookie-session
attack class) does not apply. The endpoints also do not need
`Sec-Fetch-Site` checks — there is no ambient credential a
third-party page could exploit. The web dashboard's fetch calls
include the Clerk JWT explicitly in the Authorization header.

This is documented here so a future security audit doesn't
re-raise the question.

### 17.4 CLI vs Web display consistency

Both surfaces use the same string format for the "shared with me"
list entries:

```
{owner_display} (@{owner_handle})
```

e.g. `Alice Chen (@alice-chen-a3b4)`. CLI table column header is
"Owner"; Web sidebar uses the same string. `clawdi scope list`
SHOULD NOT abbreviate to just `@handle` — that loses the
human-readable name.

### 17.5 `/api/me/scopes` response shape (owned vs shared)

Returned as `{owned: ScopeResponse[], shared: SharedScopeResponse[]}`.
Owned entries inherit the existing `/api/scopes` row shape
(no owner_* fields needed — that's the caller). Shared entries
add `owner_display`, `owner_handle`, `role`, `joined_at`. The
web type union is `OwnedScope | SharedScope` discriminated by
`is_owner: boolean`. Generated client types regenerate to
match before any frontend code lands.

## 18. Open Questions

None at spec time. Any discovered during implementation should be
appended here with date + resolution.

## 19. References

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
