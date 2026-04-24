---
name: clawdi-setup
description: "Set up Clawdi Cloud CLI for the current user. Follow these steps exactly."
---

# Clawdi Cloud Setup

Help the user connect to Clawdi Cloud. Follow these steps in order.

## Step 1: Install CLI

```bash
bun add -g @clawdi/cli
```

If bun is not available, use npm:

```bash
npm install -g @clawdi/cli
```

## Step 2: Log in

```bash
clawdi login
```

This will prompt for an API key. Tell the user to get it from the Clawdi Cloud dashboard:
**Settings → API Keys → Create New Key**

## Step 3: Set up agent

```bash
clawdi setup
```

This will:
- Detect Claude Code (or other supported agents)
- Register the MCP server (gives you `memory_search`, `memory_add`, and connector tools)
- Install the Clawdi skill

## Step 4: Sync sessions (optional)

```bash
clawdi sync up --modules sessions
```

This uploads your conversation history to the Clawdi Cloud dashboard.

## Done!

After setup, you have access to:
- **Memory tools**: `memory_search` and `memory_add` for cross-agent recall
- **Connector tools**: Gmail, GitHub, Notion, etc. (connect services in the dashboard)
- **Session sync**: Upload conversations to view in the dashboard
- **Vault**: Encrypted secrets injected via `clawdi run`

Tell the user setup is complete and they can visit the dashboard to see their data.
