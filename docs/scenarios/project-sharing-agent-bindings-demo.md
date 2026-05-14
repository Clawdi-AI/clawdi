# Project Sharing + Agent Bindings Demo

**Date:** 2026-05-14  
**Context:** Human-facing walkthrough for the PR #88 Project + Agent
model before implementation.

---

## Demo Goal

Show that Clawdi can share projects across people and then bind those
projects to agents without mixing default data boundaries.

Audience mental model:

```
Project access (share link or invitation)
      |
      v
Accepted membership
      |
      v
Agent project bindings
  - one primary
  - zero or more context projects
      |
      v
Agent runtime composition with vault provenance
```

Secrets are never displayed in the demo. We show key names, resolution
status, precedence, and provenance metadata only.

---

## Personas

- Alice owns project `engineering` and shares it.
- Bob has project `personal`.
- Carol opens a share URL before signing in.
- Dana has multiple agents and chooses where to bind.
- Evan is removed by the owner during cleanup.

---

## Demo Setup

Alice project:

- skill: `deploy-helper`
- vault key name: `OPENAI_API_KEY`

Bob project:

- `personal` starts empty.
- conflict branch adds Bob's own `OPENAI_API_KEY` to `personal`.

CLI examples assume:

```bash
export CLAWDI_API_URL=http://localhost:8000
```

Use dashboard and CLI as equivalent views of the same state.

---

## Flow 1: Owner Shares A Project

Narration: Alice shares a project boundary, not a file copy.

```bash
clawdi project show engineering
clawdi project share engineering --label "demo handoff"
```

Expected:

- Share URL is shown once.
- Link appears in revocable links list.
- No secret values are shown.

---

## Flow 2: Anonymous Preview Then Login

Narration: Carol can preview before sign-in, then attach access after
authentication.

```bash
clawdi inbox accept https://clawdi.ai/share/<token>
clawdi inbox --json
```

Expected pre-login:

- Local token is stored.
- Preview metadata is visible.
- No agent binding is created yet.

After login:

```bash
clawdi auth login
clawdi project list
```

Expected post-login:

- Pending acceptance upgrades into project membership.
- If no agent target is provided, state is access granted with binding
  pending.

---

## Flow 3: Existing User Accepts Project Access

Narration: Bob accepts access first, then decides agent bindings
explicitly.

```bash
clawdi inbox accept https://clawdi.ai/share/<token> --json
clawdi project list
clawdi agent projects list atlas --json
```

Expected:

- Membership is created.
- No implicit cross-project composition outside an agent.
- Next step is explicit agent binding.

---

## Flow 4: Email Invitation

Narration: invitation is the directed version of a share link.

Owner:

```bash
clawdi project invite engineering --email bob@example.com
clawdi project invites engineering
```

Sharee:

```bash
clawdi inbox
clawdi inbox accept <invitation-id>
```

Expected:

- Same final access result as share links.
- Binding remains a separate, explicit action.

---

## Flow 5: Bind Projects To Agents

Narration: one agent can bind many projects, but only one primary.

```bash
clawdi agent projects set-primary atlas --project personal
clawdi agent projects add-context atlas --project engineering --priority 10
clawdi agent projects list atlas --json
```

Expected:

- Exactly one primary project exists for `atlas`.
- `engineering` is added as context.
- Priority order is visible for runtime reads.

Multi-agent branch:

```bash
clawdi agent projects set-primary forge --project client-a
clawdi agent projects add-context forge --project engineering --priority 20
```

Same shared project can be bound to multiple agents without creating
project-to-project composition.

---

## Flow 6: Vault Conflict Is Visible And Safe

Narration: primary project wins by default. Conflicts block unless
explicitly allowed.

Setup:

```bash
clawdi vault set OPENAI_API_KEY --project personal
```

Resolve:

```bash
clawdi vault resolve OPENAI_API_KEY --agent atlas --debug --json
```

Expected default behavior:

- Conflict returns `vault_conflicts_blocked`.
- Debug output shows provenance chain and competing project keys.
- Secret plaintext is not shown in narrated output.

Explicit allow branch:

```bash
clawdi vault resolve OPENAI_API_KEY --agent atlas --allow-conflicts --debug --json
```

Expected:

- Resolution succeeds with explicit override.
- Provenance still shows candidate order and winner reason.

---

## Flow 7: Binding Management Without Losing Access

Narration: membership and bindings are separate states.

```bash
clawdi agent projects list atlas
clawdi agent projects remove-context atlas --project engineering
clawdi project list --shared-with-me
clawdi agent projects add-context atlas --project engineering --priority 10
```

Expected:

- Removing a context binding removes runtime visibility for that agent.
- Project membership remains.
- Rebinding is allowed while access remains.

---

## Flow 8: Owner Manages Members

Narration: owners control lifecycle and cleanup.

```bash
clawdi project members engineering
clawdi project members engineering --remove evan@example.com
clawdi project share-links engineering --revoke <prefix>
clawdi project unshare engineering
```

Expected:

- Removing a member revokes project access.
- Revoking a link blocks new accepts, not existing members.
- Unshare ends active memberships, pending invitations, and linked
  downstream access.

---

## Flow 9: Sharee Leaves

Narration: sharees can leave without owner intervention.

```bash
clawdi project leave @alice/engineering
clawdi project list --shared-with-me
clawdi agent projects list atlas
```

Expected:

- Shared access entry is removed.
- Agent context bindings based on that access are removed or disabled by
  policy.
- Owner project remains unchanged.

---

## Flow 10: Agent Handoff JSON

Narration: handoff payload carries binding and provenance-safe runtime
context.

```bash
clawdi agent handoff atlas --json
```

Expected fields:

- `agent_id`
- `primary_project`
- `context_projects` (ordered)
- `vault_resolution_policy`
- `provenance_debug_enabled`

---

## Agent Rules

1. Treat project access and agent binding as separate states.
2. Require explicit primary project before autonomous writes.
3. Prefer JSON responses for automation and policy checks.
4. Stop and ask when binding target is ambiguous.
5. Block conflict branches unless caller explicitly allows conflict.
6. Never print raw secret values in logs or summaries.

---

## Demo Readiness Checklist

Before a live walkthrough:

```bash
bash scripts/project-sharing-agent-bindings-demo.sh
bun run --filter web build
```

Confirm:

- Owner share links and invitations work.
- Acceptance creates project access independent from bindings.
- Agent can hold one primary plus context projects.
- Vault conflicts block by default and show provenance in debug mode.
- Member removal/revoke/unshare paths work.
- Sharee leave path removes sharee access.

---

## Notes

- This is a design scenario for the planned Project + Agent model.
- Existing automated test file names may retain legacy terms until
  implementation lands; the demo scenario and smoke entrypoint use
  Project + Agent language now.
