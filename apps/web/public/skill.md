---
name: clawdi-onboarding
description: First-time setup walkthrough for connecting this machine to Clawdi Cloud.
homepage: https://cloud.clawdi.ai
---

# Clawdi Cloud Setup

You're helping the user connect this machine to Clawdi Cloud — a centralized dashboard for AI agent sessions, skills, memory, and secrets across machines.

This walkthrough takes 2-3 minutes. The end state: the user's existing session history shows up at their Clawdi Cloud dashboard. If you stop earlier, the dashboard stays empty and they assume the product is broken.

## Install the CLI

```bash
bun add -g clawdi
```

If `bun` isn't installed on the system, fall back to npm:

```bash
npm install -g clawdi
```

Verify it landed:

```bash
clawdi --version
```

## Authenticate

The CLI hands the user a verification URL; they approve in their browser; you complete the handshake. Two phases because you can't block waiting for a browser click.

Start the authorization:

```bash
clawdi auth login
```

This prints a verification URL and a short user code, then exits immediately. Show both to the user in chat. Tell them: open the URL, confirm the code matches, click approve, and reply when they're done.

When they reply, finish the handshake:

```bash
clawdi auth complete
```

If it prints "Still waiting for approval" (exit code 2), the user hasn't clicked approve yet. Ask them to finish in the browser, then re-run `clawdi auth complete`. The 10-minute window starts at `auth login`; if it expires, restart from there.

⚠️ Don't pass `--manual` to `auth login` — that flag wants an interactive TTY password prompt and fails in agent contexts.

## Register agents on this machine

```bash
clawdi setup
```

Auto-detects every installed AI agent (Claude Code, Codex, Hermes, OpenClaw), registers each with the cloud, and installs the Clawdi MCP server in each agent's home. Without an `--agent` flag it picks up everything detected — which is what you want, so the next step can sync from all of them.

## Sync the user's sessions

This step fills the dashboard with the user's conversation history. Don't ask them to make a decision in the abstract — show them what's actually on their machine first, then ask. Like `git status` before `git commit`.

### Scan first

```bash
clawdi session list --all-agents --all --limit 10000 --json
```

`--limit 10000` is important — the default is 100, which would silently truncate any user with more sessions and you'd aggregate from a partial set.

If this fails (network error, no agents registered, etc.), tell the user *"I couldn't list your local sessions — going ahead with the default upload, let me know if you want to stop."* and skip to running `clawdi push --modules sessions --all-agents --all --yes`. Don't halt onboarding for this.

If the JSON is empty (`[]`), tell the user *"No sessions found on this machine — nothing to sync. Run `clawdi push` later if you start using one of the supported agents."* and continue to the next step. Skip the upload entirely.

### Show a bounded summary, then ask

Parse the JSON locally. Group by `agent`, then by `project`. Count sessions per project. Sort by count descending.

**Cap the displayed projects per agent at top 5.** A user with 100 active projects would otherwise produce a 100-line wall of text that buries the question. If there are more than 5, append a single `…and N more projects` line so they know the list is truncated. Always state the per-agent total counts (sessions and projects) so the scale is visible.

Render something like (use the user's actual paths and counts, not these numbers):

> I found 215 sessions on this machine:
>
> **Claude Code** (180 sessions across 47 projects):
> - `~/work/clawdi-cloud` — 23 sessions
> - `~/work/client-acme` — 18 sessions
> - `~/personal/blog` — 12 sessions
> - `~/work/api-gateway` — 9 sessions
> - `~/scratch` — 7 sessions
> - …and 42 more projects
>
> **Codex** (35 sessions across 8 projects):
> - `~/work/clawdi-cloud` — 11 sessions
> - `~/work/client-acme` — 8 sessions
> - `~/work/api-gateway` — 6 sessions
> - `~/personal/blog` — 5 sessions
> - `~/scratch` — 3 sessions
> - …and 3 more projects
>
> Want me to upload all of them to your Clawdi Cloud dashboard? Or are there any projects you'd rather skip — anything client-confidential, NDA work, etc.?
>
> **Reply `y` to upload all, or name any projects to skip** (works for projects not in the list above too).

The closing line about "not in the list above too" is important: the cap might hide a low-session-count NDA repo the user actually cares about excluding. Accept any project path they name, listed or not.

### Translate the answer to a push command

The user references real project names from the summary you just showed them. Match their reply to a command:

| User says | Command |
| --- | --- |
| "y" / "yes" / "ok" / "all" | `clawdi push --modules sessions --all-agents --all --yes` |
| "skip client-acme" | `clawdi push --modules sessions --all-agents --all --exclude-project ~/work/client-acme --yes` |
| "skip client-acme and scratch" | `clawdi push --modules sessions --all-agents --all --exclude-project ~/work/client-acme --exclude-project ~/scratch --yes` |
| "only Claude Code" | `clawdi push --modules sessions --agent claude_code --all --yes` |
| "only ~/work/clawdi-cloud" | `clawdi push --modules sessions --all-agents --project ~/work/clawdi-cloud --yes` |
| "n" / "no" / "skip" / "not now" | (skip — tell them *"Run `clawdi push --modules sessions --all-agents --all` whenever you want to sync."* and continue) |

Resolve `~` to an absolute path before passing to the CLI.

Note the "X new, Y updated, Z unchanged" total from the push output — you'll cite it next.

## Turn on live sync (recommended)

Without this step, the user has to remember to run `clawdi push` and `clawdi pull` by hand whenever they edit a skill. Most won't. Install the sync daemon so changes flow automatically in both directions — local edits show up on the dashboard within a second, dashboard installs land on the laptop within two.

```bash
clawdi serve install --agent claude_code
```

Replace `claude_code` with whichever agent the user has installed (you saw the list during `clawdi setup`). If they have multiple, run install once per agent — each gets its own supervised daemon.

The command writes a launchd unit on macOS or a systemd `--user` service on Linux, then loads it. The daemon stays alive across reboots and respawns on crash. Ongoing logs:

- macOS: `tail -f ~/.clawdi/serve/logs/<agent>.stderr.log`
- Linux: `journalctl --user -u clawdi-serve-<agent> -f`

What the user gets:

- Edit a SKILL.md locally → uploaded to the cloud within ~1s
- Install a skill from the dashboard → dropped into the local agent's skills directory within ~2s
- Two machines edit the same skill at once → the second editor's save shows a "Skill changed elsewhere" toast and the dashboard reloads the latest version; user re-applies their edit on top.
- Daemon offline status visible in the dashboard's agent detail page

Skip this step only if the user explicitly says they want manual sync. The CLI fallback (`clawdi push` / `clawdi pull`) still works alongside the daemon.

If install fails (no launchd / systemd, e.g. inside a minimal container), fall back to running the daemon in the foreground and ask the user to wire their own supervisor:

```bash
clawdi serve --agent claude_code
```

## Sync skills (optional one-time backup)

If the user has authored custom skills under `~/.claude/skills/`, `~/.codex/skills/`, etc., back them up to the cloud:

```bash
clawdi push --modules skills --all-agents --yes
```

Most users have zero or a handful of authored skills — no preview needed (unlike sessions, skills are deliberately created and don't have privacy concerns). The bundled `clawdi` skill that `clawdi setup` installs is automatically excluded. Re-running this is a no-op for unchanged skills.

If the user is on a new machine and already has skills in their Clawdi Cloud account, pull them down:

```bash
clawdi pull --modules skills --all-agents --yes
```

This installs cloud skills into every registered agent's home directory. Like push, it's idempotent — running again is a no-op when nothing's new.

If the user has zero authored skills, both commands are no-ops. Run them anyway to confirm; the output makes it obvious.

## Extract memories from sessions (optional)

Seed the user's Memory module by extracting facts, preferences, and decisions from the sessions they just pushed. The cloud's configured LLM does the extraction — the agent loops over recent sessions and calls the per-session endpoint via the CLI.

If the user opted out of session upload above, skip this step entirely (there's nothing in the cloud to extract from).

### List recent sessions

```bash
clawdi session list --all-agents --limit 5 --json
```

Parse the JSON. Take the `id` of each session (these are the local session ids — the same key the upload endpoint uses).

If the JSON is empty (`[]`), tell the user *"No recent sessions to extract from — skipping memory bootstrap."* and continue to Verify.

### Extract per session

For each session id from the list above, run:

```bash
clawdi session extract <id> --json
```

Each call returns `{session_id, memories_created}`. Sum `memories_created` across all 5 calls.

**Stop the loop early if the FIRST call exits with code 2** — that means the deployment hasn't configured memory extraction. Tell the user *"Memory extraction isn't configured on this deployment — skipping."* and continue to Verify.

For other failures (5xx, network), keep going — one bad session shouldn't halt the batch. Note the failure count for the summary.

### Report

Tell the user:

> ✓ Extracted N memories from M sessions{P failed if any}

If extraction was unconfigured, say that instead. Either way, continue to Verify.

## Verify

```bash
clawdi doctor
```

Every check should be green. Then point the user at their dashboard:

> All set. Open your Clawdi Cloud dashboard — you should see N sessions from this machine across {agents}.

Where N = `new + updated + unchanged` from the previous step, and {agents} is the list registered in setup.

If they opted out of session upload, just confirm setup checks passed and remind them how to push later.

## What the user got

After this their account has:

- **Memory** — `memory_search` and `memory_add` MCP tools for long-term cross-agent recall. Seeded with extractions from the sessions just pushed (if memory extraction was configured).
- **Connectors** — Gmail, GitHub, Notion, etc. They enable services in the dashboard; tools appear automatically in any registered agent.
- **Session sync** — pushed today; future sessions sync via `clawdi push`.
- **Skill sync** — authored skills backed up to the cloud and available across registered agents via `clawdi pull --modules skills`.
- **Vault** — encrypted secrets injected into commands via `clawdi run`.

## Troubleshooting

**Push reports "0 sessions" but the user has history.** The local hash cache may have drifted from the cloud (e.g. after a server-side data restore). Reset it and re-push:

```bash
rm -f ~/.clawdi/sessions-lock.json
clawdi push --modules sessions --all-agents --all --yes
```

**`clawdi auth complete` keeps saying "Still waiting for approval".** The user hasn't clicked approve yet. Re-running is safe within the 10-minute window. If it expired, restart from `clawdi auth login`.

**Older CLI doesn't recognize `--all-agents`.** Loop manually over the agents that registered in setup: `clawdi push --modules sessions --agent claude_code --all --yes`, then `--agent codex`, and so on.

**Older CLI doesn't recognize `--exclude-project`.** Tell the user to upgrade (`bun add -g clawdi` again) or accept the limitation — without it, only positive selection (`--project`) works.

**Older CLI doesn't have `clawdi session list`.** Use `clawdi push --modules sessions --all-agents --all --dry-run` — it prints scan totals per agent without the per-project breakdown.
