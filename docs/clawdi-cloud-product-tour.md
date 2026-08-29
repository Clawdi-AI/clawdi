# Clawdi Cloud product tour

This tour shows the current Clawdi Cloud experience with a synthetic Acme
Market Intelligence workspace. The demo contains four Projects, 14 Project
Skills, four empty demonstration Vaults, 25 account Memories, 12 Workspace
files, and more than 200 Agent Sessions spanning 12 months. Names, companies,
decisions, and activity are fictional.

For task-by-task instructions, use the canonical [Clawdi
Docs](https://docs.clawdi.ai). Start with the [Cloud Agent
quickstart](https://docs.clawdi.ai/cloud-agents/deploy) or [connect a local
Agent](https://docs.clawdi.ai/getting-started/quickstart).

## One product, two run paths

Clawdi brings supported Agent activity, context, and tools into one product.
A **Cloud Agent** runs in a remote runtime managed by Clawdi. A **Connected
Agent** runs on your computer. Agent software, including Hermes, OpenClaw,
Claude Code, and Codex, is a separate choice from the run path.

## Review long-running activity

The Overview activity graph summarizes Session starts across the last 12
months. The synthetic workspace has 157 active days with an even weekly rhythm
and varied daily intensity, so the dashboard demonstrates sustained Agent use
alongside recent Sessions and shared Library resources.

![Clawdi Overview with two running demo Agents and a populated 12-month Session activity heatmap](images/dashboard-activity.png)

## Start from a Running Agent

The Agent overview brings deployment state, compute, linked Projects, recent
Sessions, and shared resource counts together. A Cloud Agent can open its
Agent Interface, Files, and Terminal from the same navigation.

![A running Hermes Cloud Agent with one linked Project, recent Sessions, and 25 Memories](images/dashboard-preview.png)

Follow [Cloud Agent states and
recovery](https://docs.clawdi.ai/cloud-agents/states-and-recovery) when the
status remains unclear. Runtime state and individual tool readiness are
separate checks.

## Link selected Projects

A Project groups Project Skills and Vault access. Linking one to an Agent is
an explicit action, which makes the selected resources available without
changing Project ownership.

![Four synthetic Projects covering market intelligence, competitive research, customer advisory work, and launch intelligence](images/cloud-projects.png)

Read [Projects and
sharing](https://docs.clawdi.ai/guides/projects-and-sharing) before attaching
Vaults or inviting a Viewer.

## Build a reusable Skill library

Project Skills are Cloud-owned reusable instructions. Agent Skills remain
authoritative in the Agent software's guarded filesystem and appear in the
Cloud dashboard as a read-only inventory.

![Four synthetic Projects containing 14 Project Skills and four attached Vaults](images/cloud-skills.png)

The [Skills guide](https://docs.clawdi.ai/guides/skills) covers both locations,
copying, explicit imports, and safe review of third-party Skills.

## Scope sensitive configuration with Vaults

Vault access follows Project boundaries. The demo uses four empty Vaults to
show the attachment model while keeping the public workspace free of API keys,
tokens, and private configuration values.

![Four empty synthetic Vaults attached to four demo Projects](images/cloud-vaults.png)

Add real values only through the authorized Vault interface and attach each
Vault to the Projects that need it. See [Projects and
sharing](https://docs.clawdi.ai/guides/projects-and-sharing) for the access
model.

## Review credential-free Connector tools

Some Connector toolkits are ready without account authorization. The demo
verified Code Interpreter, Hacker News, and Composio Search; Code Interpreter
exposes five sandbox and file tools. The Overview Connector total counts
authorized external accounts, so account-free toolkits keep that total at
zero.

![Code Interpreter ready with five tools and no account connection required](images/cloud-connector-codeinterpreter.png)

Use the [connect-an-app
workflow](https://docs.clawdi.ai/guides/workflows/connect-an-app) for tool review,
account authorization, and readiness checks.

## Keep durable account context

Memories hold account-level facts, preferences, patterns, decisions, and
context that supported Agents can recall in later interactions. Each record
should be concise, reusable, and self-contained.

![Twenty-five synthetic Memories covering research cadence, decisions, formatting preferences, and demo safeguards](images/cloud-memories.png)

Memories stay outside Projects. Store credentials and tokens in Vaults. See
[Memories](https://docs.clawdi.ai/guides/memories) for categories, recall,
editing, and deletion.

## Review Agent history

Sessions provide searchable Agent conversation history for later review and
recall. Session availability and detail depend on the connected Agent
software and its synchronization path.

![Populated synthetic Session history grouped by recent activity](images/cloud-sessions.png)

See [Sessions](https://docs.clawdi.ai/guides/sessions) for search, sharing, and
export workflows.

## Use the remote Workspace

A Cloud Agent's Files view opens its private Workspace. The synthetic demo
includes quarterly reviews, operating calendars, decision logs, feedback
themes, research sources, launch plans, and KPI history.

![Twelve synthetic long-term Workspace files in the Acme demo folder](images/cloud-files.png)

Workspace files are designed to persist across normal restarts and platform
updates. Source control or another external system should hold the durable
copy of important work. Deleting a Cloud Agent permanently removes its remote
resources. Read [Agent Interface, Files, and
Terminal](https://docs.clawdi.ai/cloud-agents/agent-interface-and-terminal)
for access, readiness, and persistence boundaries.

## Continue the journey

- [Give an Agent shared context](https://docs.clawdi.ai/guides/workflows/give-an-agent-context)
- [Connect an app and verify its tools](https://docs.clawdi.ai/guides/workflows/connect-an-app)
- [Share a Project with a teammate](https://docs.clawdi.ai/guides/workflows/share-a-project)
- [Configure Cloud Agent AI access](https://docs.clawdi.ai/cloud-agents/ai-access)
