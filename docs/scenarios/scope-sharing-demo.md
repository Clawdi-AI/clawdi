# Scope Sharing Demo: Complete Product Flows

**Date:** 2026-05-13
**Context:** Demo script for `feat/scope-sharing`. Scope sharing is
workspace composition: accepting a share grants read capability, and
mounting decides where the shared content appears.

---

## Demo Goal

Show that Clawdi can share a scope across people and agents without
turning collaboration into a loose pile of copied files, leaked
secrets, or ambiguous workspaces.

The audience should leave with this mental model:

```
Owner scope
  skill + vault metadata
      |
      | share link or invitation
      v
Sharee membership
      |
      | mount into one owned workspace
      v
Composed workspace visible to agents
```

Secrets are never displayed in the demo. We only show key names,
resolution status, and precedence/debug metadata.

---

## Personas

- **Alice** owns `engineering` and shares it.
- **Bob** already has a Clawdi account with one `personal` scope.
- **Carol** opens a share URL before signing in.
- **Dana** has multiple owned scopes and must choose a mount target.
- **Evan** is removed by the owner during cleanup.

---

## Demo Setup

Alice's `engineering` scope contains:

- skill: `deploy-helper`
- vault key: `OPENAI_API_KEY`

Bob's `personal` scope is empty at first. In the conflict branch, Bob
also has his own `OPENAI_API_KEY` in `personal`.

CLI examples assume:

```bash
export CLAWDI_API_URL=http://localhost:8000
```

Use the web dashboard for the visual path, then the CLI for the
agent/operator path. They should describe the same state.

---

## Flow 1: Owner Shares A Scope

**Narration:** "Alice is not exporting a zip or copying secrets. She is
publishing a readable scope. The receiver still decides where it belongs
in their workspace."

CLI:

```bash
clawdi scope show engineering
clawdi scope share engineering --label "demo handoff"
```

Web:

1. Open Alice's `engineering` scope.
2. Open **Share**.
3. Create a link in the **Links** tab.
4. Confirm the share dialog also exposes **Invite by email** and
   **Members**.

Expected result:

- A share URL is printed once.
- Web lists the link with a revocable prefix.
- No secret value is visible.

---

## Flow 2: Anonymous Preview And Later Login

**Narration:** "Carol can open the link before she has an account. The
preview is useful, but it is not a permanent workspace until she signs
in."

CLI while signed out:

```bash
clawdi inbox accept https://clawdi.ai/share/<token>
clawdi inbox --json
```

Expected result:

- The local share token is saved on this device.
- The preview shows counts and owner context.
- No mount exists yet because Carol has no owned scope.

After login:

```bash
clawdi auth login
clawdi scope list
```

Expected result:

- Pending anonymous shares are upgraded.
- A membership is created.
- If Carol has one owned scope, the shared scope is mounted into it.
- Shared skills are eager-pulled for local agents.

Recovery branch:

- If the link was revoked before login, the CLI keeps the local token
  and reports the revoked state instead of silently dropping it.

---

## Flow 3: Existing User Accepts A Share Link

**Narration:** "Bob is the happy path. One owned workspace means Clawdi
can mount the shared scope without asking a product question he already
answered by having only one place to put it."

CLI:

```bash
clawdi inbox accept https://clawdi.ai/share/<token>
clawdi scope show personal
clawdi skill list --scope personal
clawdi vault list --scope personal
clawdi vault resolve OPENAI_API_KEY --scope personal --debug
```

Expected result:

- `inbox accept` creates membership and a mount.
- `scope show personal` shows Alice's mounted source.
- `skill list` includes `deploy-helper` from Alice's scope.
- `vault list` includes Alice's vault metadata.
- `vault resolve --debug` shows which scope won; the secret value is
  not printed during the narrated demo.

Web:

1. Bob opens `personal`.
2. The mounted source appears in the mount/composition panel.
3. Shared skills and vault metadata appear as composed content.

---

## Flow 4: Email Invitation

**Narration:** "A link is good for lightweight sharing. An invitation is
better when Alice knows the exact registered user."

Owner CLI:

```bash
clawdi scope invite engineering --email bob@example.com
clawdi scope invites engineering
```

Sharee CLI:

```bash
clawdi inbox
clawdi inbox accept <invitation-id> --into personal
```

Web:

1. Alice opens **Share -> Invite by email**.
2. Bob opens his inbox and accepts.

Expected result:

- Invitation creates the same capability + mount shape as the link
  flow.
- `--into` makes the mount target explicit for scripts and agents.

---

## Flow 5: Multiple Workspaces Require A Choice

**Narration:** "If Dana owns more than one workspace, Clawdi refuses to
guess. This is one of the places where the product should slow down."

CLI:

```bash
clawdi inbox accept https://clawdi.ai/share/<token> --json
clawdi scope mount engineering --into client-a --alias alice-engineering
```

Expected result:

- The first command reports `mount_target_ambiguous`.
- Dana has the membership, but the source is not mounted anywhere yet.
- The explicit mount command completes the composition.

Web:

1. Accept the share.
2. Pick the parent scope from the mount-target picker.

Agent logic:

- Use `--json` and look for `mount_target_ambiguous`.
- Do not invent a mount target.
- Ask the human or use a caller-provided `--into`.

---

## Flow 6: Vault Conflict Is Visible And Safe

**Narration:** "Bob can receive Alice's key name even if he already has
one locally, but Bob's own workspace keeps priority. Shared values are
available only if Bob explicitly accepts the conflict."

Setup:

```bash
clawdi vault set OPENAI_API_KEY --scope personal
```

Conflict attempt:

```bash
clawdi inbox accept https://clawdi.ai/share/<token> --into personal --json
```

Expected result:

- The response reports `vault_conflicts_blocked`.
- Nothing surprising is mounted in a non-interactive flow.

Explicit acceptance:

```bash
clawdi inbox accept https://clawdi.ai/share/<token> \
  --into personal \
  --allow-vault-conflicts

clawdi vault resolve OPENAI_API_KEY --scope personal --debug
```

Expected result:

- The mount is created.
- Debug resolution shows Bob's parent value wins.
- Alice's matching shared key is skipped by precedence, not leaked.

---

## Flow 7: Mount Management Without Losing Access

**Narration:** "Membership answers whether Bob can read Alice's scope.
Mount answers where that scope appears. Bob can unmount without burning
the relationship."

CLI:

```bash
clawdi scope mounts personal
clawdi scope unmount personal @alice/engineering
clawdi scope list
clawdi scope mount engineering --into personal --alias alice-engineering
```

Expected result:

- Unmount removes Alice's content from `personal`.
- Bob still has membership.
- Bob can mount it again into the same or another owned scope.

Web:

1. Use the mount panel to unmount.
2. Use "Add shared scope" to mount it again.

---

## Flow 8: Owner Manages Members

**Narration:** "The owner has a lifecycle surface. They can inspect who
accepted, remove one person, revoke links, or stop sharing entirely."

CLI:

```bash
clawdi scope members engineering
clawdi scope members engineering --remove evan@example.com
clawdi scope share-links engineering --revoke <prefix>
clawdi scope unshare engineering
```

Web:

1. Open Alice's **Share -> Members** tab.
2. Remove Evan.
3. Use **Stop sharing** when the demo is done.

Expected result:

- Removing a member deletes their membership and mount edges.
- Revoking a link blocks new accepts, but does not remove existing
  members.
- `unshare` removes accepted members, pending invitations, share links,
  and downstream mount edges.

---

## Flow 9: Sharee Leaves

**Narration:** "A receiver can also end the relationship without asking
Alice. Leaving removes both capability and workspace composition."

CLI:

```bash
clawdi scope leave @alice/engineering
clawdi scope list
clawdi scope mounts personal
```

Expected result:

- Bob no longer sees Alice's scope as shared-with-me.
- Mount edges from Bob's workspaces are removed.
- Alice's source scope is unchanged.

---

## What Agents Should Do

Agents should prefer the JSON forms:

```bash
clawdi inbox accept --url <link> --into <scope> --json
clawdi scope list --json
clawdi scope show <scope> --json
clawdi scope mounts <scope> --json
clawdi vault resolve OPENAI_API_KEY --scope <scope> --debug --json
```

Agent rules:

- Treat `membership` and `mount` as separate states.
- If accept returns `mount_target_ambiguous`, stop and ask for a parent
  scope instead of guessing.
- If accept or mount returns `vault_conflicts_blocked`, explain the
  parent-first precedence and require `--allow-vault-conflicts`.
- Never print secret values in logs or natural-language summaries.
- After accepting or mounting, refresh scope and skill state before
  claiming the agent can use the shared skill.

---

## What Humans Should See

Human UI should make these states obvious:

- "Shared with you but not mounted" is not an error; it is a pending
  composition decision.
- A mount row should show source owner, source scope, alias, and remove
  action.
- Member management belongs in the share dialog because it is an owner
  lifecycle task.
- Vault conflicts should read as "your local value keeps priority",
  not as a scary secret merge.
- Stop sharing should be framed as an owner-wide cleanup, distinct from
  revoking one link.

---

## Demo Readiness Checklist

Before a live demo:

```bash
bash scripts/scope-sharing-demo.sh
bun run --filter web build
```

Confirm:

- Alice can create and revoke share links.
- Bob can accept and auto-mount with one owned scope.
- Dana sees a mount-target choice with multiple owned scopes.
- Vault conflict branch blocks first, then succeeds with explicit
  override.
- Members tab can remove one member and stop sharing.
- Sharee leave removes their own mount edges.
- No screen or terminal output shows raw vault values.

---

## Automated Coverage Map

Backend:

- `backend/tests/test_scope_sharing_e2e.py`
- `backend/tests/test_vault_resolution_mounts.py`

CLI:

- `packages/cli/tests/commands/auth.test.ts`
- `packages/cli/tests/commands/inbox-and-mount-json.test.ts`
- `packages/cli/tests/commands/scope-members.test.ts`
- `packages/cli/tests/commands/scope-show.test.ts`
- `packages/cli/tests/commands/vault-resolve.test.ts`

Manual web checks:

- `apps/web/src/components/sharing/share-scope-dialog.tsx`
- `apps/web/src/components/sharing/scope-mounts-panel.tsx`

---

## Known Caveats

- This iteration is read-only for sharees. Shared writes are not part of
  the demo.
- Sessions and memories are intentionally not mounted.
- Mount resolution is shallow in this iteration.
- Web E2E should be added once authenticated dashboard fixtures are
  stable; the current runnable demo covers the product paths through API
  and CLI contracts.
