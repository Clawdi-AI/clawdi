# Clawdi Cross-User Scope Sharing — Complete CLI Demo

> From "nothing in the cloud" to "Bob has Alice's skills + vault keys on his
> laptop" in nine commands. Every block below is real CLI input/output —
> captured live against the running backend, not mocked.

---

## TL;DR

Two paths to share a scope's contents across users, both end-to-end working
on **CLI and web**, symmetric:

| Path | Recipient | Onboarding cost |
|------|-----------|-----------------|
| **Share link** | Anyone with the URL (no account needed first) | URL → use skills immediately; sign in later to keep them |
| **Email invitation** | A teammate who already has a Clawdi account | Click "Accept" in their dashboard (or CLI inbox) |

**Read access**: shared scope's skills land on the sharee's disk under
`~/.claude/skills/<key>__<owner-handle>/` (and equivalents for codex,
openclaw, hermes). Vault key names are visible; plaintext resolution
stays gated on Clerk auth.

**Write access**: read-only viewer. Owner keeps full control.

---

## Cast

| | Role | What they do |
|---|---|---|
| **Alice** | Owner | Authors a skill + vault secrets, generates share links, sends invitations, revokes a leaked link |
| **Bob** | Curious link recipient | Receives a URL out-of-band, accepts anonymously first, later signs in to convert to a permanent member |
| **Carol** | Email-invited teammate | Sees invitation in her CLI inbox, accepts in one command — gets the skill on her disk too |

---

## Flow at a glance

```
┌─────────────────────────────────────────────────────────────────────┐
│  PART I    Alice authors content                                    │
│            • clawdi skill add <folder>                              │
│            • clawdi vault import <.env> --yes                       │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PART II   Alice generates a share link                             │
│            • clawdi scope share <slug> --label …                    │
└─────────────────────────────────────────────────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                                                   ▼
┌─────────────────────┐                         ┌─────────────────────┐
│ PART III · Bob      │                         │ PART IV · Carol     │
│  • share accept     │                         │  • clawdi scope     │
│    (anonymous)      │                         │    invites          │
│  • share list       │                         │    --accept <id>    │
│  • later: log in    │                         │  • skill lands on   │
│  • skill lands      │                         │    disk             │
└─────────────────────┘                         └─────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PART V    Alice revokes Bob's link                                 │
│            • clawdi scope share-links <slug> --revoke <prefix>      │
│            • Carol stays a member (separate code path)              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## How content gets into a scope (read this first)

A `scope` is the container that holds skills + vault secrets + sessions for
sharing. **You don't create scopes ad-hoc** — they come from one of two
places:

| Scope | How it's created | Quantity |
|-------|------------------|----------|
| **Personal** | Auto-created at signup | Exactly 1 per user |
| **Environment** | Auto-created when you register an agent with `clawdi setup --agent <type>` | One per registered agent |

**Adding content** to a scope:

| Command | Default target | Explicit target |
|---------|----------------|-----------------|
| `clawdi skill add <folder>` | Default-write scope | `--scope <id-or-slug>` or `--agent <type>` |
| `clawdi vault set <key>` | Default-write scope | `--scope <id-or-slug>` |
| `clawdi vault import <.env>` | Default-write scope | `--scope <id-or-slug>` |

> **What's "default-write scope"?** If you've registered any agents,
> it's the most-recently-active agent's environment scope. Otherwise,
> Personal. Use `clawdi scope list` to see all your scopes and
> `--scope` to target one explicitly.

---

## PART I · Setting up content (Alice the owner)

### 1.1 — Inventory: what scopes do I have?

```bash
alice@laptop $ clawdi scope list
```

```
My scopes (2):
  engineering-5df715       b045725e-e4d6-4514-87f6-6dce74e7dcc6  (environment)
    Engineering
  personal-5df715-alice    4a921f8b-6a94-4f15-9d2b-8b7f4774dbb1  (personal)
    Personal
```

> Alice has two scopes: her auto-created Personal scope and an `Engineering`
> environment-scope (created when she registered an agent earlier via
> `clawdi setup --agent claude_code`). For this demo she'll add content
> into `Engineering` specifically and share THAT scope.

### 1.2 — Add a skill explicitly into the Engineering scope

```bash
alice@laptop $ ls /tmp/demo-skill-git-helper/
SKILL.md

alice@laptop $ clawdi skill add /tmp/demo-skill-git-helper \
                                --scope engineering-5df715 --yes
✓ Uploaded demo-skill-git-helper (v1, 1 files)

alice@laptop $ clawdi skill list --json | jq -r '.[] | "  - \(.skill_key) (\(.scope_name))"'
  - demo-skill-git-helper  (scope: Engineering)
```

> The `--scope engineering-5df715` flag pins the upload to a specific scope.
> Drop the flag → goes to default-write. Pass `--agent codex` instead → goes
> to the codex env-scope. The CLI resolves scope by UUID, slug, OR human
> name (case-insensitive), so any of these work:
>
>   `--scope engineering-5df715`  (slug)
>   `--scope b045725e-e4d6-4514-87f6-6dce74e7dcc6`  (UUID)
>   `--scope Engineering`  (name)

### 1.3 — Bulk-import vault secrets into the Engineering scope

```bash
alice@laptop $ cat /tmp/demo-team.env
GITHUB_TEAM_TOKEN=ghp_team_shared_token_abc123
SENTRY_DSN=https://demo@sentry.io/0
SLACK_WEBHOOK=https://hooks.slack.com/services/T0/B0/abc

alice@laptop $ clawdi vault import /tmp/demo-team.env \
                                   --scope engineering-5df715 --yes
```

```
◇  3 keys from /tmp/demo-team.env ─╮
│                                  │
│  GITHUB_TEAM_TOKEN               │
│  SENTRY_DSN                      │
│  SLACK_WEBHOOK                   │
│                                  │
├──────────────────────────────────╯
✓ Imported 3 keys to vault "default"
```

```bash
alice@laptop $ clawdi vault list
```

```json
[
  {
    "slug": "default",
    "scope_id": "b045725e-e4d6-4514-87f6-6dce74e7dcc6",
    "name": "Default",
    "items": {
      "(default)": [
        "GITHUB_TEAM_TOKEN",
        "SENTRY_DSN",
        "SLACK_WEBHOOK"
      ]
    }
  }
]
```

**Behind the scenes**
- Values encrypted at rest with `VAULT_ENCRYPTION_KEY` (AES-256-GCM,
  separate from `ENCRYPTION_KEY` which guards MCP proxy JWTs).
- Plaintext resolution is `clawdi vault resolve` (CLI ApiKey auth only).
  The web dashboard never sees plaintext — only key names.

> For one-off secrets use `clawdi vault set <key>` (interactive
> prompt). `vault import --yes` is for bulk loads + CI bootstrap.

---

## PART II · Sharing the scope

### 2.1 — Generate a share link

```bash
alice@laptop $ clawdi scope share engineering-5df715 --label "weekend hack"
```

```
✓ Share link ready

  http://localhost:3000/share/qInf5TPgrnISEsCQ9xM6kW_jnahQmfmQul2S83oVV2c

Save this URL now — only the prefix qInf5TPg remains visible later.
Owner handle: @alice-b4b6
Label: weekend hack

Recipient runs: clawdi share accept http://localhost:3000/share/qInf5TPg…
```

**Design call-outs**
- Server stores **only the SHA-256 hash + prefix** going forward. The raw
  token shown above is unrecoverable from the database.
- `owner_handle = kebab(name) + "-" + user_id.hex[:4]` is **frozen** on the
  link row. Alice can rename herself; Bob's on-disk skill paths stay
  unchanged.

### 2.2 — List active links

```bash
alice@laptop $ clawdi scope share-links engineering-5df715
```

```
Share links (1):
  qInf5TPg… [weekend hack]  active  5/11/2026  0 redeems

Revoke: clawdi scope share-links engineering-5df715 --revoke <prefix>
```

> Listings show **prefix-only**; the raw URL is not recoverable.
> Use `--revoke <prefix>` to invalidate.

---

## PART III · Bob accepts the link

### 3.1 — Anonymous accept (no login)

```bash
# Bob hasn't logged in yet — straight from URL to usable skills.
bob@laptop $ clawdi share accept http://localhost:3000/share/qInf5TPg…
```

```
✓ Accepted "Engineering" from Alice (@alice-b4b6)
  1 skill · 3 vault secrets (sign in to use)
  Token saved to ~/.clawdi/share-tokens.json (0600).

Daemon syncs shared scopes automatically. Run `clawdi serve` if you don't
already have one running, or `clawdi share list` to see this and other
accepted shares.

To unlock vault secrets, sign in with clawdi auth login. Your accepted
shares auto-convert to permanent memberships.
```

```bash
bob@laptop $ clawdi share list
```

```
Shared scopes on this device (1):

  Engineering  — from Alice (@alice-b4b6)
    scope_id: b045725e-e4d6-4514-87f6-6dce74e7dcc6
    accepted: 2026-05-12T04:08:09.461Z

1 share not yet upgraded to permanent membership — sign in with
clawdi auth login to convert them.
```

**Design call-out — zero-friction onboarding**
- No account required to accept.
- Token stored locally at `0600`; other users on the same machine can't read it.
- The CLI tells Bob exactly what to do to unlock secrets: log in.

### 3.2 — Alice sees Bob's redemption tick the counter

```bash
alice@laptop $ clawdi scope share-links engineering-5df715
```

```
Share links (1):
  qInf5TPg… [weekend hack]  active  5/11/2026  1 redeem · last used 5/11/2026
```

### 3.3 — Bob signs in → auto-upgrade + eager skill pull

```bash
# After `clawdi auth login` Bob's terminal carries an api_key.
# Re-running `share accept` on the SAME URL takes the /upgrade fast path
# AND eagerly pulls the scope's skills into every registered adapter.

bob@laptop $ clawdi share accept http://localhost:3000/share/qInf5TPg…
```

```
✓ Joined as viewer — your dashboard now lists this scope.
  Owner handle: @alice-b4b6
  Scope ID: b045725e-e4d6-4514-87f6-6dce74e7dcc6

  Pulled 1 skill from this scope into your local agents.

Run `clawdi scope list` to see it alongside your own scopes.
```

### 3.4 — Proof: Alice's skill is now on Bob's disk

```bash
bob@laptop $ ls $CLAUDE_CONFIG_DIR/skills/
demo-skill-git-helper__alice-b4b6

bob@laptop $ cat $CLAUDE_CONFIG_DIR/skills/demo-skill-git-helper__alice-b4b6/SKILL.md
```

```markdown
---
name: git-helper
description: Helpers for everyday git tasks — branch hygiene, stash management, conflict resolution
---

# git-helper

Quick reference for the team's git conventions.

## Branch hygiene
- Feature branches: `feat/<short-desc>`
- Bug fixes: `fix/<short-desc>`
- Always squash before rebasing onto main.

## Stash management
git stash save "WIP: description"
git stash list
git stash pop --index
```

**Design call-out — content actually moves**
- The same `share accept` command writes to **every registered adapter** —
  `~/.claude/skills/` for claude-code, `~/.codex/skills/` for codex, etc.
- The `__<owner-handle>` suffix keeps shared skills distinct from Bob's
  own (which use the bare `<key>` name).
- Extraction is atomic: rename-into-trash, rename-into-place, nuke-trash.
  An interrupted reconcile leaves either the old or the new content,
  never a partial.

### 3.5 — Bob's `scope list` now shows the shared scope

```bash
bob@laptop $ clawdi scope list
```

```
My scopes (1):
  personal-5df715-bob      d35b213c-4713-4111-b457-1f89d14281ff  (personal)
    Personal

Shared with me (1):
  engineering-5df715       b045725e-e4d6-4514-87f6-6dce74e7dcc6  (environment)
    Personal
```

### 3.6 — Bob can read Alice's vault key names too

```bash
bob@laptop $ clawdi vault list
```

```json
[
  {
    "slug": "default",
    "scope_id": "b045725e-e4d6-4514-87f6-6dce74e7dcc6",
    "name": "Default",
    "items": {
      "(default)": [
        "GITHUB_TEAM_TOKEN",
        "SENTRY_DSN",
        "SLACK_WEBHOOK"
      ]
    }
  }
]
```

> Bob sees the **key names** (metadata) but plaintext resolution is gated
> separately. `clawdi vault resolve <key>` works because Bob is signed in;
> a leaked anonymous share-token cannot exfiltrate secrets.

---

## PART IV · Email invitation flow (Carol)

### 4.1 — Alice invites Carol by email

```bash
alice@laptop $ clawdi scope invite engineering-5df715 --email carol-5df715@example.com
```

```
✓ Invitation sent to carol-5df715@example.com
  They'll see it in their /skills banner + `clawdi scope invites` inbox.
```

```bash
alice@laptop $ clawdi scope invites engineering-5df715   # owner-side
```

```
Invitations on this scope (1):
  carol-5df715@example.com  (bb34abb7…) · sent 5/11/2026

Cancel: clawdi scope invites engineering-5df715 --cancel <id>
```

> Invitations target a **registered** Clawdi account by email. For unregistered
> emails the CLI returns `user_not_found` with a hint to send a share-link
> instead. Same for `ambiguous_email` (multiple accounts with that
> address) — privacy-safe: we never silently pick which one.

### 4.2 — Carol checks her inbox and accepts

```bash
carol@laptop $ clawdi scope invites
```

```
Pending invitations (1):
  Engineering  (bb34abb7…)
    from Alice @alice-b4b6 · 5/11/2026

Accept: clawdi scope invites --accept <id>
Decline: clawdi scope invites --decline <id>
```

```bash
carol@laptop $ clawdi scope invites --accept bb34abb7-fc8a-46f2-89da-528c50fd95c9
```

```
✓ Accepted invitation, joined as viewer.
  Scope ID: b045725e-e4d6-4514-87f6-6dce74e7dcc6
  Owner handle: @alice-b4b6
  Pulled 1 skill into your local agents.
```

```bash
carol@laptop $ ls $CLAUDE_CONFIG_DIR/skills/
demo-skill-git-helper__alice-b4b6

carol@laptop $ clawdi scope list
```

```
My scopes (1):
  personal-5df715-carol    8a2c2ca0-0634-46a2-8598-68903214edfb  (personal)
    Personal

Shared with me (1):
  engineering-5df715       b045725e-e4d6-4514-87f6-6dce74e7dcc6  (environment)
    Personal
```

> Accept is transactional — scope row locked, membership inserted,
> invitation deleted, skills eagerly pulled, all in one command. No daemon
> restart needed.

---

## PART V · Revoking Bob's link

### 5.1 — Owner revoke

```bash
alice@laptop $ clawdi scope share-links engineering-5df715 --revoke qInf5TPg
✓ Link revoked.

alice@laptop $ clawdi scope share-links engineering-5df715
```

```
Share links (1):
  qInf5TPg… [weekend hack]  revoked  5/11/2026  1 redeem · last used 5/11/2026

Revoke: clawdi scope share-links engineering-5df715 --revoke <prefix>
```

### 5.2 — Carol's membership survives

```bash
# Revoke kills FUTURE redemptions of THIS link — but does not remove
# already-joined members. Carol joined via invite (a separate code
# path), so she stays a member.

carol@laptop $ clawdi scope list
```

```
My scopes (1):
  personal-5df715-carol    8a2c2ca0-0634-46a2-8598-68903214edfb  (personal)
    Personal

Shared with me (1):
  engineering-5df715       b045725e-e4d6-4514-87f6-6dce74e7dcc6  (environment)
    Personal
```

**Design call-out — orthogonal revocation**

| Action | What it kills |
|--------|---------------|
| **Revoke link** | Future redemptions of THIS link |
| **Remove member** *(future B.7)* | One specific person, link stays usable for others |
| **Unshare scope** *(future B.8)* | All links + all members at once |

The owner picks the surgical instrument. Pre-fix in many SaaS products,
"revoke link" silently removed every member who'd ever joined via it —
bad UX when one user accidentally shares a link they shouldn't.

---

## Command reference

### Owner-side (manage your scopes)

| Command | Purpose |
|---------|---------|
| `clawdi scope list` | Owned + shared-with-me scopes |
| `clawdi skill add <folder>` | Upload a skill to default-write scope |
| `clawdi skill add <folder> --scope <slug>` | Upload to an explicit scope (UUID/slug/name) |
| `clawdi skill add <folder> --agent codex` | Upload to a specific agent's env-scope |
| `clawdi vault set <key>` | Add a single secret (interactive prompt) |
| `clawdi vault set <key> --scope <slug>` | Add a secret to an explicit scope |
| `clawdi vault import <.env> --yes` | Bulk-import secrets from a `.env` file |
| `clawdi vault import <.env> --scope <slug> --yes` | Bulk-import into an explicit scope |
| `clawdi scope share <scope> [--label TEXT]` | Generate a share link |
| `clawdi scope share-links <scope>` | Inspect links on that scope |
| `clawdi scope share-links <scope> --revoke <prefix>` | Revoke one link |
| `clawdi scope invite <scope> --email <addr>` | Send an email invitation |
| `clawdi scope invites <scope>` | Owner-side invitation listing |
| `clawdi scope invites <scope> --cancel <id>` | Cancel a pending invitation |

### Sharee-side (someone shared with you)

| Command | Purpose |
|---------|---------|
| `clawdi share accept <url>` | Accept a share link (anon → token; signed-in → membership + auto-pull) |
| `clawdi share list` | Local-only view of accepted share tokens |
| `clawdi share remove <scope-id>` | Drop local token + clean adapter folders |
| `clawdi scope invites` | Your inbox — pending invitations addressed to you |
| `clawdi scope invites --accept <id>` | Accept an invitation, eagerly pulls skills |
| `clawdi scope invites --decline <id>` | Decline an invitation |
| `clawdi scope list` | Owned + shared scopes with `is_owner` marker |
| `clawdi vault resolve <key>` | Get a vault secret's plaintext (Clerk-auth-gated) |

### `<scope>` accepts

- The full UUID (e.g. `5f60763f-3541-4484-a396-71adfeab9f78`)
- The slug (e.g. `engineering-5df715` or `team-toolkit`)
- The human name (case-insensitive match against `Scope.name`)
- `default` → uses `resolve_default_write_scope`

---

## Where the content actually lives

After `clawdi share accept` on the signed-in path:

```
~/.claude/skills/
├── my-own-skill/                              ← Bob's own skills
│   └── SKILL.md
└── demo-skill-git-helper__alice-b4b6/         ← shared from Alice
    └── SKILL.md
```

```
~/.codex/skills/
└── demo-skill-git-helper__alice-b4b6/
```

```
~/.openclaw/agents/main/skills/
└── demo-skill-git-helper__alice-b4b6/
```

```
~/.hermes/skills/shared/
└── demo-skill-git-helper__alice-b4b6/
```

**Why a path suffix?** Without `__<owner-handle>`, if Alice and Bob's friend
both share a skill named `git-helper`, the second redemption would clobber
the first. Frozen owner-handles partition the namespace per sharer.

---

## How an agent "uses" a shared scope

Two paths:

**1. The agent already runs locally** — Skills land in the adapter's
skills directory (shown above). On next conversation, the agent picks up
the new `__<owner-handle>` folder via its normal skill-discovery loop.
For Claude Code that means `~/.claude/skills/<key>__<handle>/SKILL.md` is
read on next CLI invocation. No restart needed.

**2. The agent isn't registered yet (`clawdi setup` first)** — Register
the local agent with the cloud:

```bash
$ clawdi setup --agent claude_code
```

This:
- Detects the local install (looks for `~/.claude/`, asks if not found)
- Creates an `AgentEnvironment` row server-side
- Binds an env-scoped default scope to that env
- Writes the MCP server config so the agent can talk back to the cloud
- Installs the bundled `clawdi` skill for self-introspection

After `setup`, `clawdi serve` runs a daemon that watches local agent
state and keeps it in sync with the cloud. Accepted shares sync on the
next reconcile cycle automatically.

> **For the demo**, `share accept` does the eager pull itself, so the
> shared skill appears immediately — no daemon required.

---

## What makes this design strong

1. **Frozen owner handle** — `kebab(name)-hex[:4]` stamped on the
   link/membership at create time. Owner renames don't break sharees'
   local paths.

2. **Anonymous-then-upgrade** — a single URL serves both states. Sharee
   gets immediate value; identity gets attached later. Same UX shape as
   Figma's "anyone with the link" → "sign in to save".

3. **Hash-only token storage** — server never holds the raw token after
   issue. A DB leak does not compromise active share links.

4. **Env-binding boundary preserved** — a leaked hosted-pod deploy key
   cannot accept share-links, mint new ones, or join scopes. Sharing is
   account-level; hosted pods stay scope-restricted (PR #77's blast-radius
   contract holds).

5. **Read-only viewers** — sharees can *use* skills and resolve vault
   secrets, but never edit. Owner keeps full control of content.

6. **Symmetric CLI ↔ web** — every action above works in the dashboard's
   `ShareScopeDialog` (owner) and `InvitationsInbox` banner (invitee).
   Pick whichever surface fits the user's mood.

7. **Orthogonal revocation** — revoke a link, remove a member, or unshare
   the whole scope. Three different surgical tools, three different
   blast radii.

---

## Try it locally

```bash
# 1. Boot the backend
cd backend && uv run uvicorn app.main:app --port 8000 &

# 2. Seed three personas with API keys + Personal scopes
uv run python /tmp/seed-three-users.py
# (prints export ALICE_KEY=… etc — eval into your shell)
source /tmp/seed-vars.sh

# 3. Replay the demo above
/tmp/run-demo.sh "$ALICE_KEY" "$ALICE_SCOPE_SLUG" \
                 "$BOB_KEY" "$CAROL_KEY" "$CAROL_EMAIL"
```

The seed script + demo runner live at:
- `/tmp/seed-three-users.py` (creates owner + 2 sharees with Personal scopes + API keys)
- `/tmp/run-demo.sh` (drives the 9-act sequence)

Full captured transcript: `/tmp/demo-transcript.txt` (247 lines of real CLI I/O).

---

## Implementation status

| Phase | Coverage | Tests |
|-------|----------|-------|
| **A** — Models, migration, share-token primitives, auth deps | ✅ Done | 24 tests |
| **B.1–B.6** — Owner endpoints: create/list/revoke links + invitations | ✅ Done | 14 tests |
| **C.1, C.4, C.5** — Sharee endpoints: preview, redeem, upgrade, /me/inbox | ✅ Done | 10 tests |
| **D.1, D.3** — Visibility helper + read endpoints permit shared-scope viewers | ✅ Done | 3 tests |
| **E** — CLI: 5 owner commands + sharee accept/list/remove + eager skill pull | ✅ Done | 282 tests |
| **F** — Web dashboard: ShareScopeDialog + InvitationsInbox banner | ✅ Done | — |
| **B.7** — Members list/remove | Open | — |
| **B.8** — Unshare in one call | Open | — |
| **C.2/C.3** — Anonymous-token skill content stream (for daemon sync without auth login) | Open | — |

**Total test coverage:** 226 backend tests · 282 CLI tests · all green.

**Branch:** [`feat/scope-sharing`](https://github.com/Clawdi-AI/clawdi/tree/feat/scope-sharing)
