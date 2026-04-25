---
name: clawdi-setup
description: "Set up Clawdi Cloud CLI for the current user. Follow these steps exactly."
---

# Clawdi Cloud Setup

Help the user connect to Clawdi Cloud. Follow these steps in order.

## Step 1: Install CLI

```bash
bun add -g clawdi
```

If bun is not available, use npm:

```bash
npm install -g clawdi
```

## Step 2: Log in

```bash
clawdi auth login
```

This opens the user's browser to a one-click authorization page on the Clawdi Cloud dashboard. Tell them to confirm the request — the CLI will pick up the credentials automatically. If their environment can't open a browser (SSH, container), tell them to run `clawdi auth login --manual` and paste an API key from **Settings → API Keys**.

## Step 3: Set up agent

```bash
clawdi setup
```

This will:
- Detect installed agents (Claude Code, Codex, Hermes, OpenClaw)
- Register the MCP server (gives you `memory_search`, `memory_add`, and connector tools)
- Install the Clawdi skill

## Step 4: Verify

```bash
clawdi doctor
```

Confirms auth, API reachability, agent installation, and MCP wiring. Resolve any failing check before continuing.

## Step 5: Sync sessions (optional)

```bash
clawdi push --modules sessions
```

This uploads your conversation history to the Clawdi Cloud dashboard.

## Done!

After setup, you have access to:
- **Memory tools**: `memory_search` and `memory_add` for cross-agent recall
- **Connector tools**: Gmail, GitHub, Notion, etc. (connect services in the dashboard)
- **Session sync**: Upload conversations to view in the dashboard
- **Vault**: Encrypted secrets injected via `clawdi run`

Tell the user setup is complete and they can visit the dashboard to see their data.
