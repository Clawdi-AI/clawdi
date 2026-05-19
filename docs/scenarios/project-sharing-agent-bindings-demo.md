# Project Sharing + Agent Project Demo

**Date:** 2026-05-14
**Status:** Ship-state walkthrough for Project collaboration and Agent Project use.

## Product Model

- Project is a shared library object with resources, membership, and access controls.
- Project resources include skills, vault key names, and vault env values for CLI/API-key runtime reads.
- Agent has one fixed Agent Project for default writes.
- Agent can attach multiple Projects for reads during runs.
- Sharing grants Project membership only. It does not attach the Project to an agent.
- Composition happens only when a user chooses to attach a Project to an Agent.
- A project folder link is local CLI configuration that tells
  `clawdi run` which Project to use for vault env injection from a folder.
- Folder links do not grant membership, attach Projects to Agents, or
  change cloud Project relationships.
- `clawdi run --project <project>` uses an explicit Project;
  `clawdi run -- <cmd>` can use the linked folder's Project; and
  `clawdi run --no-project-folder -- <cmd>` skips local folder lookup.
- Revoking membership or stopping sharing removes future agent use for affected members.

## Personas

- Alice owns project `engineering`.
- Bob receives viewer access and uses `engineering` with Agent `atlas`.
- Carol accepts an invitation, then declines a later one.
- Dana operates multiple agents and changes attachment order.
- Evan is removed during cleanup.

CLI examples assume:

```bash
export CLAWDI_API_URL=http://localhost:8000
```

This PR's demo surface is CLI + backend. Dashboard pages are deferred
to the separate web PR. Folder links are CLI-only local preferences:

- CLI: `project`, `project folder`, `inbox`, `agent projects`, `run`, `vault`, `skill`, `push`, and `pull` commands.
- API: project, sharing, inbox, Agent Project, skill, and vault routes.

## Role Matrix

| Role | Path | CLI/API | Web PR follow-up |
| --- | --- | --- | --- |
| Project owner | Create/list/show project | `clawdi project create`, `list`, `show` | Projects list/detail |
| Project owner | Create/list/revoke share links | `clawdi project share`, `share-links --revoke` | Share dialog |
| Project owner | Invite/list/cancel invitations | `clawdi project invite`, `invites --cancel` | Share dialog |
| Project owner | List/remove people | `clawdi project members --remove` | Project detail / Share dialog |
| Project owner | Stop all sharing | `clawdi project unshare` | Share dialog |
| Recipient | Preview or accept share link | `/api/share/<token>/preview`, `clawdi inbox accept <url>` | `/share/<token>` landing |
| Recipient | List/accept/decline invitations | `clawdi inbox`, `accept`, `decline` | Inbox banner |
| Recipient | List accessible projects | `clawdi project list --shared-with-me` | Projects list |
| Recipient | Leave shared project | `clawdi project leave @owner/project` | Project detail |
| Recipient | Attach accepted Project to Agent | `clawdi inbox accept --agent`, `agent projects attach` | Agent detail Projects tab |
| Agent operator | View the Agent Project and attached Projects | `clawdi agent projects list` | Agent detail Projects tab |
| Agent operator | Attach/detach/move projects | `attach`, `detach`, `move` | Agent detail Projects tab |
| Local operator | Link a folder to a Project for `run` env selection | `clawdi project folder link`, `status`, `unlink` | None |
| Local operator | Run with linked or explicit Project vault env | `clawdi run`, `run --project`, `run --no-project-folder` | None |
| Security | Agent API keys cannot manage sharing | sharing routes reject Agent API keys | API guard display |
| Security | Plaintext vault values stay CLI/API-key only, but Project members read them like owners | web/JWT cannot call `vault resolve`; members can resolve via CLI/API key | API guard display |
| Revoke/conflict | Conflict block/allow and access cleanup | `vault resolve --agent`, unshare/leave/remove | Error copy / stale attachment cleanup |

## Role Logic Review

| Role | What they want | Where the action lives | Invariant that prevents misuse |
| --- | --- | --- | --- |
| Project owner human | Share `engineering`, inspect who has access, and revoke access without controlling recipients' agents. | `clawdi project share`, `invite`, `members --remove`, `unshare`; dashboard equivalent in web PR. | Sharing grants Project membership only; it never attaches the Project to an Agent unless the recipient or operator explicitly asks. |
| Recipient human | Accept, decline, or leave shared Project access, then decide whether an Agent should use it. | `clawdi inbox accept`, `decline`, `project leave`, optional `inbox accept --agent` or later `agent projects attach`; dashboard equivalent in web PR. | Accepting without an explicit Agent leaves all Agents unchanged; viewer access cannot become the Agent Project. |
| Agent operator human | See Agent Project and attachments. | `clawdi agent projects list`, `attach`, `detach`, `move`; dashboard equivalent in web PR. | Agent Project handles default writes; attachments are ordered read sources. |
| Local operator human using `clawdi run` | Run a local command with vault env from an explicit or linked Project. | CLI only; `clawdi run --project`, `clawdi project folder link/status/unlink`, `clawdi run --no-project-folder`. | Folder links are local selection hints for `run`; they do not grant membership, change cloud state, or attach Projects to Agents. |
| Agent runtime / automation consumer | Resolve reads deterministically, write to the right default Project, and debug provenance/conflicts. | Agent Project APIs; `clawdi vault resolve --agent --debug --json`, future agent runtime calls. | Precedence is the Agent Project first, then attached Projects by explicit order; conflicts block by default and include provenance without leaking plaintext. |
| Security/admin revocation perspective | Stop future access and downstream Agent use when membership changes. | Project member removal, recipient leave, owner unshare, audit/admin views. | Project membership gates access; revocation removes affected attached Projects while preserving owner data and rejecting sharing changes from Agent API keys. |

## Flow 1: Owner Creates And Shares

Alice creates or opens an owned project, adds Project resources, and shares it.

```bash
clawdi project create "Engineering" --slug engineering
clawdi project show engineering
clawdi project share engineering --label "demo share"
clawdi project share-links engineering
```

Expected:

- The project appears under My projects.
- CLI/API listings expose People / Access, Invites, and Links state.
- The generated share URL is shown once and clearly marked as read-only viewer access.
- Link listings show the prefix, label, timestamps, accepts, and revoke affordance.
- Revoking a share link stops future accepts only; accepted viewers stay members until
  `project members --remove`, `project leave`, or `project unshare` changes membership.
- Secret plaintext is not shown in dashboard/web flows. CLI/API-key runtime paths can resolve shared Project vault values for members.

Web PR follow-up: Projects list/detail and Share dialog should mirror
the same People / Access, Invites, and Links state.

## Flow 2: Recipient Accepts A Link

Bob accepts through the CLI. The share landing page is covered by the
separate web PR.

```bash
clawdi inbox accept https://clawdi.ai/share/<token> --json
clawdi project list --shared-with-me
clawdi project show @alice/engineering
```

Expected:

- Project access is accepted as viewer access.
- The project appears under Shared with me with `@alice/engineering`.
- Skills and vault key names are readable; writes stay disabled.
- Vault env values resolve through CLI/API-key runtime paths; web/JWT still cannot read plaintext.
- Human CLI output names the exact follow-up command:
  `clawdi agent projects attach <agent-id> --project @alice/engineering`.
- No Project is attached to an Agent unless Bob passes `--agent`.

Web PR follow-up: `/share/<token>` should preview the same Project
access and route accepted users to Project detail / Agent use actions.

## Flow 3: Recipient Accepts And Attaches To Agent

Bob can accept and attach the project to an agent in one CLI step, or accept first and attach later.

```bash
clawdi inbox accept https://clawdi.ai/share/<token> --agent <atlas-id> --json
clawdi agent projects list <atlas-id> --json
```

Or attach later:

```bash
clawdi agent projects attach <atlas-id> --project @alice/engineering --order 10
clawdi agent projects list <atlas-id>
```

Expected:

- `engineering` appears as an attached Project on `atlas`.
- Bob's Agent Project remains fixed to `atlas`.
- Shared viewer Projects cannot become the Agent Project.

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

Dana reviews Agent Project and attachments, then changes read order.

```bash
clawdi agent projects list <atlas-id> --json
clawdi agent projects attach <atlas-id> --project @alice/engineering --order 10
clawdi agent projects attach <atlas-id> --project client-a --order 20
clawdi agent projects move <atlas-id> --item <engineering-attachment-id>:20 --item <client-attachment-id>:10
clawdi agent projects detach <atlas-id> --project @alice/engineering
```

Expected:

- Agent Project is always visible and fixed.
- Attachment order is explicit and stable.
- Detaching a Project stops that Agent from using the Project but does not remove membership.

Web PR follow-up: Agent detail should show the fixed Agent Project plus
ordered attached Projects with attach, move, and detach actions.

## Flow 6: Local Project Folder Selection For Run

Bob links a local checkout to a Project he can already access. This is a
local shortcut for `clawdi run`, not an Agent attachment.

```bash
cd ~/work/engineering
clawdi project folder link --project @alice/engineering
clawdi project folder status
clawdi run -- npm run deploy
```

Explicit Project override:

```bash
clawdi run --project personal -- python main.py
```

Skip folder lookup:

```bash
clawdi run --no-project-folder -- python main.py
```

Cleanup:

```bash
clawdi project folder unlink
```

Expected:

- The link is local CLI configuration for the folder.
- The operator must already have Project access; linking does not grant membership.
- `clawdi run --project` uses the explicit Project instead of the linked folder.
- `clawdi run --no-project-folder` ignores linked folders and uses run behavior without local folder selection.
- The Agent Project and attached Projects do not change. Use `clawdi agent projects ...` when an Agent should use the Project during Agent Project resolution.

## Flow 7: Vault Provenance And Conflicts

Setup: Alice and Bob both have key name `OPENAI_API_KEY`; Bob attaches Alice's project to an agent.

```bash
clawdi vault list --project @alice/engineering
clawdi vault resolve OPENAI_API_KEY --agent <atlas-id> --debug --json
```

Expected default behavior:

- The command fails with `vault_conflicts_blocked`.
- The response shows Project order, winning candidate metadata, and conflicts.
- The blocked response does not include plaintext.

Explicit allow branch:

```bash
clawdi vault resolve OPENAI_API_KEY --agent <atlas-id> --allow-conflicts --debug --json
```

Expected:

- First match wins according to the Agent's Project order.
- Provenance shows the source project, order, vault slug, section, and item name.

Security branch:

- Web/JWT auth cannot call `vault resolve`.
- Agent API keys cannot manage sharing or invitations.
- Plaintext vault resolution remains CLI/API-key only, and Project members can resolve shared Project values like owners.

## Flow 8: Skills, Pull, And Push Project Flags

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

## Flow 9: Revoke, Leave, And Unshare

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
- Link revoke alone does not remove existing members; use member removal or unshare for that.
- Existing owners and owned project data remain intact.

## Verification

Run the local demo smoke after starting the dev Postgres service:

```bash
docker compose up -d postgres
bash scripts/project-sharing-agent-bindings-demo.sh
```

The script preflights `pdm`, `bun`, and the database endpoint before running backend/CLI checks, so demo setup failures are reported without a pytest traceback.

For full CLI/backend PR verification, also run:

```bash
bun run check
bunx turbo typecheck --filter=clawdi
cd packages/cli && bun test
cd backend && pdm run ruff check app tests scripts
cd backend && pdm run pytest -q
scripts/serve-e2e.sh
```
