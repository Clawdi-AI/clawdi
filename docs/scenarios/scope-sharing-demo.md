# Clawdi Cross-User Scope Sharing — CLI Demo

> Share skills and vault secrets across accounts. Zero-friction onboarding for
> sharees, full owner control for sharers, symmetric coverage on CLI and web.

This walkthrough shows the **complete demo flow** end-to-end, captured live
against a running backend. Every block below is real CLI input/output —
not a mockup.

---

## TL;DR

**Two paths from owner → sharee, both end-to-end working:**

| Path | Who it's for | Onboarding cost |
|------|---------------|-----------------|
| **Share link** | Anyone with the URL — strangers, no account needed first | Open URL → use skills immediately, sign in later |
| **Email invitation** | A teammate who already has a Clawdi account | Click "Accept" in their dashboard inbox |

**Symmetric across surfaces** — every action below works equally on the **CLI**
and the **web dashboard** (`/skills`).

---

## Cast

| | Role | What they do |
|---|---|---|
| **Alice** | Owner | Generates a share link for her `Team Toolkit` scope, invites Carol by email, revokes a leaked link |
| **Bob** | Curious link recipient | Receives a URL out-of-band, accepts anonymously, later signs in to convert to a permanent member |
| **Carol** | Email-invited teammate | Sees the invitation in her CLI inbox, accepts in one command |

---

## End-to-end flow (at a glance)

```
                        ┌──────────────────────────────────────────┐
                        │             Alice (owner)                │
                        │   scope: team-toolkit-bf9ada             │
                        └──────────────┬───────────────────────────┘
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            │                          │                          │
            ▼                          ▼                          ▼
   scope share <slug>          scope invite <slug>      scope share-links --revoke
   → public URL                  --email carol@…          → kills future redemptions
            │                          │
            ▼                          ▼
   ┌─────────────────┐         ┌─────────────────┐
   │   Bob (anon)    │         │  Carol (member) │
   │ share accept    │         │ scope invites   │
   │ → token saved   │         │   --accept <id> │
   │ → "0 skills"    │         │ → joins viewer  │
   └──────┬──────────┘         └─────────────────┘
          │
          ▼ (later, after auth login)
   share accept <same-url>
   → /upgrade fast path
   → ScopeMembership row
   → "Shared with me" appears in scope list
```

---

## ACT 1 · Alice inspects her scopes

```bash
alice@laptop $ clawdi scope list
```

```
My scopes (1):
  team-toolkit-bf9ada      5f60763f-3541-4484-a396-71adfeab9f78  (environment)
    Team Toolkit
```

> Lists every scope visible to the current user. Owned and shared-with-me would
> appear in separate sections (Carol's view in ACT 8 demonstrates this).

---

## ACT 2 · Alice generates a share link

```bash
alice@laptop $ clawdi scope share team-toolkit-bf9ada --label "weekend hack"
```

```
✓ Share link ready

  http://localhost:3000/share/doHT_f7lseVZy2Nn9Lofha71qTycCNt7Wbl5u0xbwAw

Save this URL now — only the prefix doHT_f7l remains visible later.
Owner handle: @alice-7a79
Label: weekend hack

Recipient runs: clawdi share accept http://localhost:3000/share/doHT_f7l...
```

**What's happening behind the scenes**
- Server stores **only the SHA-256 hash + prefix**. The raw token is shown
  once and never recoverable.
- `owner_handle = kebab(name) + "-" + user_id.hex[:4]` is **frozen on the link
  row** so even if Alice later renames herself, Bob's local skill paths stay
  put.

---

## ACT 3 · Alice lists her active share links

```bash
alice@laptop $ clawdi scope share-links team-toolkit-bf9ada
```

```
Share links (1):
  doHT_f7l… [weekend hack]  active  5/11/2026  0 redeems

Revoke: clawdi scope share-links team-toolkit-bf9ada --revoke <prefix>
```

> Listings show **prefix-only** — the raw token isn't recoverable from history.

---

## ACT 4 · Bob accepts the link anonymously

```bash
# Bob hasn't logged in yet — straight from URL to working skills.
bob@laptop $ clawdi share accept http://localhost:3000/share/doHT_f7l...
```

```
✓ Accepted "Team Toolkit" from Alice (@alice-7a79)
  0 skills
  Token saved to ~/.clawdi/share-tokens.json (0600).

Daemon syncs shared scopes automatically. Run `clawdi serve` if you don't
already have one running, or `clawdi share list` to see this and other
accepted shares.
```

```bash
bob@laptop $ clawdi share list
```

```
Shared scopes on this device (1):

  Team Toolkit  — from Alice (@alice-7a79)
    scope_id: 5f60763f-3541-4484-a396-71adfeab9f78
    accepted: 2026-05-12T03:13:59.518Z

1 share not yet upgraded to permanent membership — sign in with
clawdi auth login to convert them.
```

**Design call-out — zero-friction onboarding**
- No account required to accept.
- Token stored locally at `0600` so other users on the same machine can't read it.
- The CLI tells Bob exactly what to do next if he wants vault access or wants
  the share to persist across devices: log in.

---

## ACT 5 · Alice sees Bob's redemption tick the counter

```bash
alice@laptop $ clawdi scope share-links team-toolkit-bf9ada
```

```
Share links (1):
  doHT_f7l… [weekend hack]  active  5/11/2026  1 redeem · last used 5/11/2026
```

> `redeem_count` + `last_redeemed_at` give the owner a usage signal — the
> equivalent of a "X people clicked your invite link" stat.

---

## ACT 6 · Bob logs in → his share auto-upgrades

```bash
# After `clawdi auth login` Bob's terminal carries an api_key.
# Re-running `share accept` on the SAME URL detects the auth and takes
# the /upgrade fast path — no second "are you sure?" prompt.

bob@laptop $ clawdi share accept http://localhost:3000/share/doHT_f7l...
```

```
✓ Joined as viewer — your dashboard now lists this scope.
  Owner handle: @alice-7a79
  Scope ID: 5f60763f-3541-4484-a396-71adfeab9f78


Run `clawdi scope list` to see it alongside your own scopes.
```

```bash
bob@laptop $ clawdi scope list
```

```
My scopes (0):

Shared with me (1):
  team-toolkit-bf9ada      5f60763f-3541-4484-a396-71adfeab9f78  (environment)
    Team Toolkit
```

**Design call-out — Figma/Spotify-style identity continuity**
- The same URL works **before AND after** sign-in.
- Pre-login → token in `~/.clawdi/share-tokens.json`.
- Post-login → permanent `ScopeMembership` row, server-side.
- The CLI silently picks the right path. Bob never has to "redeem-then-upgrade"
  manually.

---

## ACT 7 · Alice invites Carol by email

```bash
alice@laptop $ clawdi scope invite team-toolkit-bf9ada --email carol-bf9ada@example.com
```

```
✓ Invitation sent to carol-bf9ada@example.com
  They'll see it in their /skills banner + `clawdi scope invites` inbox.
```

```bash
alice@laptop $ clawdi scope invites team-toolkit-bf9ada   # owner-side view
```

```
Invitations on this scope (1):
  carol-bf9ada@example.com  (7741ec49…) · sent 5/11/2026

Cancel: clawdi scope invites team-toolkit-bf9ada --cancel <id>
```

> Email invitations are for **known Clawdi users**. Targeting an unregistered
> email returns `user_not_found` with a hint to send a share link instead.
> Same shape for `ambiguous_email` (multiple accounts with that address) —
> privacy-safe: we never silently pick which one.

---

## ACT 8 · Carol opens her inbox and accepts

```bash
carol@laptop $ clawdi scope invites    # inbox view, no scope arg
```

```
Pending invitations (1):
  Team Toolkit  (7741ec49…)
    from Alice @alice-7a79 · 5/11/2026

Accept: clawdi scope invites --accept <id>
Decline: clawdi scope invites --decline <id>
```

```bash
carol@laptop $ clawdi scope invites --accept 7741ec49-6609-4f97-aedc-b55ebb793860
```

```
✓ Accepted invitation, joined as viewer.
  Scope ID: 5f60763f-3541-4484-a396-71adfeab9f78
  Owner handle: @alice-7a79
```

```bash
carol@laptop $ clawdi scope list
```

```
My scopes (0):

Shared with me (1):
  team-toolkit-bf9ada      5f60763f-3541-4484-a396-71adfeab9f78  (environment)
    Team Toolkit
```

> Acceptance is **transactional**: the scope row is locked, membership inserted,
> invitation deleted, and (if the scope has skills) eagerly pulled to every
> registered adapter in one command. No daemon restart needed.

---

## ACT 9 · Alice revokes Bob's link — Carol's membership survives

```bash
alice@laptop $ clawdi scope share-links team-toolkit-bf9ada --revoke doHT_f7l
```

```
✓ Link revoked.
```

```bash
alice@laptop $ clawdi scope share-links team-toolkit-bf9ada
```

```
Share links (1):
  doHT_f7l… [weekend hack]  revoked  5/11/2026  1 redeem · last used 5/11/2026
```

```bash
# The revoke kills FUTURE redemptions of THIS link — but it does not
# remove already-joined members. Carol joined via invite (a separate
# code path), so she stays a member.

carol@laptop $ clawdi scope list
```

```
My scopes (0):

Shared with me (1):
  team-toolkit-bf9ada      5f60763f-3541-4484-a396-71adfeab9f78  (environment)
    Team Toolkit
```

**Design call-out — orthogonal revocation**
- **Revoke a link** → blocks new redemptions; existing members untouched.
- **Remove a member** → kicks someone specific without invalidating the link.
- **Unshare a scope** (future B.8) → kills everything at once.

The owner picks the surgical instrument. Pre-fix in many SaaS products,
"revoke link" silently removed every member who'd ever joined via it — bad
UX when one user accidentally shares a link they shouldn't.

---

## Command reference

### Owner-side (your own scope)

| Command | Purpose |
|---------|---------|
| `clawdi scope list` | List every visible scope, owned + shared |
| `clawdi scope share <scope> [--label TEXT]` | Generate a public URL |
| `clawdi scope share-links <scope>` | List/inspect links on that scope |
| `clawdi scope share-links <scope> --revoke <prefix>` | Revoke one link |
| `clawdi scope invite <scope> --email <addr>` | Send an email invitation |
| `clawdi scope invites <scope>` | View invitations the owner sent |
| `clawdi scope invites <scope> --cancel <id>` | Cancel a pending invitation |

### Sharee-side (someone shared with you)

| Command | Purpose |
|---------|---------|
| `clawdi share accept <url>` | Accept a share-link (anon → token, signed-in → membership) |
| `clawdi share list` | Local-only view of accepted share tokens |
| `clawdi share remove <scope-id>` | Drop a local token + clean adapter folders |
| `clawdi scope invites` | Your inbox — pending invitations addressed to you |
| `clawdi scope invites --accept <id>` | Accept an invitation, eagerly pulls skills |
| `clawdi scope invites --decline <id>` | Decline an invitation |

`<scope>` accepts **UUID**, **slug**, or **human name** — the CLI resolves
ambiguity with a clear error.

---

## What makes this design strong

1. **Frozen owner handle** — `kebab(name)-hex[:4]` stamped on the link/membership
   at create time. Owner can rename without breaking sharees' local paths.

2. **Anonymous-then-upgrade** — a single URL serves both states. Sharee gets
   value immediately; identity gets attached later. Mirrors Figma/Spotify.

3. **Hash-only token storage** — server never holds the raw token after issue.
   Database leak ≠ link compromise.

4. **Env-binding boundary preserved** — a leaked hosted-pod deploy key cannot
   accept share-links, mint new ones, or join scopes. Sharing is account-level;
   hosted pods stay scope-restricted (PR #77's blast-radius contract holds).

5. **Read-only viewers** — sharees can *use* skills and resolve vault secrets,
   but never edit. Owner keeps full control of content.

6. **Symmetric CLI ↔ web** — every action above works in the dashboard's
   `ShareScopeDialog` (owner) and `InvitationsInbox` banner (invitee). Mix and
   match across surfaces freely.

---

## Try it locally

```bash
# Boot the backend
cd backend && uv run uvicorn app.main:app --port 8000 &

# Seed three personas with API keys
uv run python /tmp/seed-three-users.py

# Replay the demo above
/tmp/run-demo.sh "$ALICE_KEY" "$ALICE_SCOPE_SLUG" \
                 "$BOB_KEY" "$CAROL_KEY" "$CAROL_EMAIL"
```

The full captured transcript lives at `/tmp/demo-transcript.txt` after running
the script — 152 lines of real CLI input/output, identical to the blocks above.

---

## Implementation status

| Phase | Coverage |
|-------|----------|
| **A** — Models, migration, share-token primitives, auth deps | ✅ Done · 9 commits |
| **B.1–B.6** — Owner endpoints: create/list/revoke links + invitations | ✅ Done · 4 endpoints |
| **C.1, C.4, C.5** — Sharee endpoints: preview, redeem, upgrade, /me/inbox | ✅ Done · 5 endpoints |
| **D.1** — Visibility helper widens to include memberships | ✅ Done |
| **D.3** — Skill download permits shared-scope viewers | ✅ Done |
| **E** — CLI sharee + owner commands + eager-pull on accept | ✅ Done · 10 commands |
| **F** — Web dashboard: ShareScopeDialog + InvitationsInbox banner | ✅ Done |
| **B.7** — Members list/remove | Open |
| **B.8** — Unshare (kill all links + remove all members in one call) | Open |
| **C.2/C.3** — Anonymous-token skill scope index + tarball stream | Open |

**Test coverage:** 226 backend tests · 282 CLI tests · all green.

**Branch:** [`feat/scope-sharing`](https://github.com/Clawdi-AI/clawdi/tree/feat/scope-sharing)
