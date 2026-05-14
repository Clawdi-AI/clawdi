# Project Sharing + Agent Workspace Demo

**Date:** 2026-05-14  
**Status:** Ship-state walkthrough for Project collaboration and agent workspace use.

## Product Model

- Project is a shared workspace/library object with resources, membership, and access controls.
- Project resources include skills and vault key names. Secret values are never shown in this demo.
- Agent has one Home project. Home is the default writable workspace for that agent.
- Agent can attach multiple Projects so their resources are available during runs.
- Sharing grants Project membership only. It does not attach the Project to an agent.
- Composition happens only when a user chooses to attach a Project to an Agent.
- Revoking membership or stopping sharing removes future agent use for affected members.

## Personas

- Alice owns project `engineering`.
- Bob receives viewer access and uses `engineering` with agent `atlas`.
- Carol accepts an invitation, then declines a later one.
- Dana operates multiple agents and changes attached project order.
- Evan is removed during cleanup.

CLI examples assume:

```bash
export CLAWDI_API_URL=http://localhost:8000
```

Use the dashboard and CLI as equivalent views of the same state:

- Dashboard: Projects list/detail, Share dialog, Inbox banner, share landing page, Agent detail Projects tab.
- CLI: `project`, `inbox`, `agent projects`, `vault`, `skill`, `push`, and `pull` commands.

## Role Matrix

| Role | Path | Dashboard | CLI/API |
| --- | --- | --- | --- |
| Project owner | Create/list/show project | Projects page | `clawdi project create`, `list`, `show` |
| Project owner | Create/list/revoke share links | Share dialog | `clawdi project share`, `share-links --revoke` |
| Project owner | Invite/list/cancel invitations | Share dialog | `clawdi project invite`, `invites --cancel` |
| Project owner | List/remove people | Project detail / Share dialog | `clawdi project members --remove` |
| Project owner | Stop all sharing | Share dialog | `clawdi project unshare` |
| Recipient | Preview share link | `/share/<token>` landing | `clawdi inbox accept <url>` |
| Recipient | List/accept/decline invitations | Inbox banner | `clawdi inbox`, `accept`, `decline` |
| Recipient | List accessible projects | Projects page | `clawdi project list --shared-with-me` |
| Recipient | Leave shared project | Project detail | `clawdi project leave @owner/project` |
| Recipient | Use accepted project with an agent | Agent detail Projects tab | `clawdi inbox accept --agent`, `agent projects add-context` |
| Agent operator | View Home and attached projects | Agent detail Projects tab | `clawdi agent projects list` |
| Agent operator | Set Home project | Agent detail Projects tab | `clawdi agent projects set-primary` |
| Agent operator | Attach/detach/reorder projects | Agent detail Projects tab | `add-context`, `remove-context`, `reorder` |
| Security | Env-bound keys cannot manage sharing | API guard | sharing routes reject env-bound keys |
| Security | Plaintext vault values stay CLI/API-key only | API guard | web/JWT cannot call `vault resolve` |
| Revoke/conflict | Conflict block/allow and access cleanup | Error copy / stale attachment cleanup | `vault resolve --agent`, unshare/leave/remove |

## Flow 1: Owner Creates And Shares

Alice creates or opens an owned project, adds workspace resources, and shares it.

```bash
clawdi project create "Engineering" --slug engineering
clawdi project show engineering
clawdi project share engineering --label "demo share"
clawdi project share-links engineering
```

Expected:

- The project appears under My projects.
- The share dialog opens on People / Access, with Invites and Links available as adjacent tabs.
- The generated share URL is shown once and clearly marked as read-only viewer access.
- Link listings show the prefix, label, timestamps, accepts, and revoke affordance.
- No secret plaintext is shown.

Dashboard path:

1. Open Projects.
2. Open `engineering`.
3. Use Share or Manage sharing.
4. Confirm People / Access, Invites, and Links reflect the current sharing state.

## Flow 2: Recipient Accepts A Link

Bob opens the share landing page or accepts through the CLI.

```bash
clawdi inbox accept https://clawdi.ai/share/<token> --json
clawdi project list --shared-with-me
clawdi project show @alice/engineering
```

Expected:

- Project access is accepted as viewer access.
- The project appears under Shared with me with `@alice/engineering`.
- Skills and vault key names are readable; writes stay disabled.
- Human CLI output names the exact follow-up command:
  `clawdi agent projects add-context <agent-id> --project @alice/engineering`.
- No agent attachment is created unless Bob passes `--agent`.

Dashboard path:

1. Open `/share/<token>`.
2. Accept project access.
3. Land on the project detail page.
4. Use the Use with agent affordance or go to an agent detail Projects tab.

## Flow 3: Recipient Accepts And Uses With An Agent

Bob can accept and attach the project to an agent in one CLI step, or accept first and attach later.

```bash
clawdi inbox accept https://clawdi.ai/share/<token> --agent <atlas-id> --json
clawdi agent projects list <atlas-id> --json
```

Or attach later:

```bash
clawdi agent projects add-context <atlas-id> --project @alice/engineering --priority 10
clawdi agent projects list <atlas-id>
```

Expected:

- `engineering` appears as an attached project on `atlas`.
- Bob's Home project remains owned by Bob.
- Shared viewer projects cannot be set as Home.

## Flow 4: Invitations And Inbox

Alice sends Carol a directed invitation.

```bash
clawdi project invite engineering --email carol@example.com
clawdi project invites engineering
```

Carol reviews and accepts:

```bash
clawdi inbox --json
clawdi inbox accept <invitation-id> --json
```

Decline branch:

```bash
clawdi inbox decline <invitation-id>
```

Owner cleanup branch:

```bash
clawdi project invites engineering --cancel <invitation-id>
```

Expected:

- Invitations show owner display and owner handle.
- Accept creates the same viewer access as a share link.
- Decline or cancel removes the pending invitation without affecting existing members.

## Flow 5: Agent Operator Manages Projects

Dana reviews the Home project and attached projects, sets Home, attaches projects, and reorders them.

```bash
clawdi agent projects list <atlas-id> --json
clawdi agent projects set-primary <atlas-id> --project personal
clawdi agent projects add-context <atlas-id> --project @alice/engineering --priority 10
clawdi agent projects add-context <atlas-id> --project client-a --priority 20
clawdi agent projects reorder <atlas-id> --item <engineering-attachment-id>:20 --item <client-attachment-id>:10
clawdi agent projects remove-context <atlas-id> --project @alice/engineering
```

Expected:

- The Home project is always visible.
- Attached project order is explicit and stable.
- Detaching a project stops that agent from using the project but does not remove membership.

Dashboard path:

1. Open Agents.
2. Open `atlas`.
3. Select Projects.
4. Set Home, attach a project, move rows up/down, and detach a project.

## Flow 6: Vault Provenance And Conflicts

Setup: Alice and Bob both have key name `OPENAI_API_KEY`; Bob attaches Alice's project to an agent.

```bash
clawdi vault list --project @alice/engineering
clawdi vault resolve OPENAI_API_KEY --agent <atlas-id> --debug --json
```

Expected default behavior:

- The command fails with `vault_conflicts_blocked`.
- The response shows project order, winning candidate metadata, and conflicts.
- The blocked response does not include plaintext.

Explicit allow branch:

```bash
clawdi vault resolve OPENAI_API_KEY --agent <atlas-id> --allow-conflicts --debug --json
```

Expected:

- First match wins according to the agent's project order.
- Provenance shows the source project, order, vault slug, section, and item name.

Security branch:

- Web/JWT auth cannot call `vault resolve`.
- Env-bound deploy keys cannot manage sharing or invitations.
- Plaintext vault resolution remains CLI/API-key only.

## Flow 7: Skills, Pull, And Push Project Flags

Project-aware skill commands target a project explicitly when needed.

```bash
clawdi skill list --project @alice/engineering --json
clawdi skill add ./deploy-helper --project engineering --yes
clawdi skill install owner/repo/path --project engineering --yes
clawdi skill rm deploy-helper --project engineering
clawdi pull --modules skills --project @alice/engineering --agent codex --yes
```

Session push `--project` remains a local path filter:

```bash
clawdi push --modules sessions --project ~/work/client-a --agent codex --yes
```

Expected:

- Shared project skills can be listed and pulled as read-only resources.
- Skill writes require an owned project.
- Session push does not use cloud project aliases.

## Flow 8: Revoke, Leave, And Unshare

Membership removal also removes future agent use for the affected member.

Remove a single member:

```bash
clawdi project members engineering
clawdi project members engineering --remove evan@example.com --json
```

Recipient leaves:

```bash
clawdi project leave @alice/engineering --json
```

Owner stops all sharing:

```bash
clawdi project unshare engineering --json
```

Expected:

- Removed members no longer see the project in `project list --shared-with-me`.
- Agent attachments for revoked users are pruned.
- Revoked links cannot be accepted by new recipients.
- Existing owners and owned project data remain intact.

## Verification

Run the no-Docker smoke:

```bash
bash scripts/project-sharing-agent-bindings-demo.sh
```

For full PR verification, also run:

```bash
bun run check
bun run typecheck
cd backend && uv run ruff check app tests
cd backend && uv run python -c "import app.main; print('import ok')"
```
