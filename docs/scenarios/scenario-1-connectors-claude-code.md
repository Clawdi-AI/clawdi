# Scenario 1: Clawdi + Claude Code (CLI-First)

**Date:** 2026-04-15
**Context:** Based on product-design.md, adopting CLI-first approach over remote MCP endpoint.

---

## Overview

Two-phase setup: `clawdi setup` registers a local MCP server into Claude Code's config (one-time), then `clawdi run -- claude` handles vault injection and launches the agent. No remote MCP endpoint, no per-agent token configuration.

---

## Step 0: Install and Login

```bash
# Install
brew install clawdi

# Login (OAuth Device Auth, RFC 8628)
$ clawdi login
> Visit: https://clawdi.ai/activate
> Enter code: WDJB-MJHT
> Waiting...
✓ Authorized as paco@example.com
✓ Token saved to ~/.clawdi/config
```

Login happens once. Token persists in `~/.clawdi/config`.

### Register MCP Server (one-time)

```bash
$ clawdi setup
✓ Registered clawdi MCP server in Claude Code
  → wrote to ~/.claude.json: {"type":"stdio","command":"clawdi","args":["mcp","stdio"]}
✓ Registered clawdi MCP server in Cursor
  → wrote to ~/.cursor/mcp.json
```

Under the hood, `clawdi setup` calls `claude mcp add-json` to register a stdio MCP server:

```bash
# What clawdi setup does internally for Claude Code:
claude mcp add-json clawdi '{"type":"stdio","command":"clawdi","args":["mcp","stdio"]}' --scope user
```

This tells Claude Code: "whenever you start, spawn `clawdi mcp stdio` as a local MCP server." The registration persists in `~/.claude.json` — no need to repeat.

---

## Step 1: Configure Resources in Dashboard

One-time setup at `clawdi.ai`:

```
Vault:
  ├── OPENAI_API_KEY=sk-xxx
  ├── ANTHROPIC_API_KEY=sk-ant-xxx
  └── STRIPE_SECRET_KEY=sk_live_xxx

Connectors:
  ├── GitHub ✓ (OAuth authorized)
  ├── Notion ✓
  └── Linear ✓

Memory:
  └── (accumulated from previous agent sessions)

Skills:
  ├── web-search.md ✓
  └── github-workflow.md ✓
```

---

## Step 2: Sync Static Resources to Local

```bash
# Pull skills to local files
clawdi skills sync
# → ~/.clawdi/skills/web-search.md
# → ~/.clawdi/skills/github-workflow.md

# Reference in Claude Code's CLAUDE.md
# @~/.clawdi/skills/
```

Skills are static config — loaded before the session starts, not fetched at runtime.

---

## Step 3: Launch Claude Code

```bash
clawdi run -- claude
```

`clawdi run` only handles vault injection + exec. MCP is already configured from `clawdi setup`.

```
clawdi run -- claude
  │
  ├── 1. Vault Injection (Layer 2 — never enters LLM context)
  │     Fetch secrets from Clawdi API
  │     Set as child process env vars:
  │       OPENAI_API_KEY=sk-xxx
  │       ANTHROPIC_API_KEY=sk-ant-xxx
  │     SDK reads env vars directly. LLM context never sees raw keys.
  │
  └── 2. exec(claude)
        Launch Claude Code.
        Claude Code reads ~/.claude.json, finds registered clawdi MCP server,
        spawns "clawdi mcp stdio" as a child process.
        The MCP server reads ~/.clawdi/config for auth token,
        connects to Clawdi API, exposes tools:
          connector_list()
          connector_call(service, action, params)
          memory_search(query)
          memory_add(content)
```

### What each component is responsible for

| Component | Responsibility |
|-----------|---------------|
| `clawdi setup` (one-time) | Register MCP server config in `~/.claude.json` |
| `clawdi run` (each launch) | Vault env injection + exec agent |
| `clawdi mcp stdio` (spawned by Claude Code) | Local MCP server, proxies connector/memory calls to Clawdi API |
| Claude Code | Reads MCP config, spawns MCP server, calls tools during conversation |

---

## Usage Examples

### Querying a connected service

```
User: Check open bugs in the INGEST project on Linear

Claude Code:
  → calls connector_call("linear", "list_issues",
      {project: "INGEST", status: "open", label: "bug"})
  → path: Claude Code → clawdi mcp stdio → Clawdi API → Composio → Linear API
  → issue list returned to LLM context
  → Claude Code presents results
```

### Cross-agent memory

```
User: Save the fix for this connection pool bug

Claude Code:
  → calls memory_add("INGEST-142: connection pool leak, fixed by...")
  → stored in Clawdi Memory (pgvector)

--- later, in Cursor ---

$ clawdi run -- cursor

User: How did we fix that connection pool issue?

Cursor:
  → calls memory_search("connection pool")
  → retrieves the memory saved from Claude Code session
  → no re-explanation needed
```

---

## Data Flow

```
┌──────────────────────────────────────────────────────────────┐
│  clawdi run -- claude                                        │
│  (vault injection + exec)                                    │
│                                                              │
│  ┌─────────────────────┐    ┌─────────────────────────────┐  │
│  │ Claude Code process │    │ clawdi mcp stdio            │  │
│  │                     │    │ (spawned by Claude Code     │  │
│  │ env:               │    │  from ~/.claude.json config) │  │
│  │  OPENAI_API_KEY ────┼──→ │ SDK uses directly,          │  │
│  │  ANTHROPIC_API_KEY  │    │ LLM unaware                 │  │
│  │                     │    │                             │  │
│  │ LLM tool calls: ───┼──→ │  connector_call() ──────────┼──┼──→ Clawdi API
│  │                     │    │  memory_search()  ──────────┼──┼──→ Clawdi API
│  │                     │    │  memory_add()     ──────────┼──┼──→ Clawdi API
│  │                     │    │                             │  │
│  │ system prompt:      │    └─────────────────────────────┘  │
│  │  @~/.clawdi/skills/ │    (skills are local files,         │
│  │  (loaded at start)  │     no MCP needed)                  │
│  └─────────────────────┘                                     │
└──────────────────────────────────────────────────────────────┘
         │                              │
         │ model calls                  │ tool calls
         ▼                              ▼
   api.openai.com                 api.clawdi.ai/v1/
   (uses env key,                  connectors → Composio → GitHub/Notion/Linear
    or Clawdi Gateway)             memory → pgvector
```

**Note:** `clawdi run` and `clawdi mcp stdio` are separate processes with different responsibilities:
- `clawdi run`: injects vault env vars, then exec's claude (process replaces itself)
- `clawdi mcp stdio`: spawned later by Claude Code as a child process, reads auth from `~/.clawdi/config`

---

## CLI-First vs Remote MCP (Design Decision)

| Aspect | Remote MCP (original design) | CLI-First (this approach) |
|--------|------------------------------|---------------------------|
| Connectors/Memory | Agent connects to `mcp.clawdi.ai` directly | Local MCP server, proxies to API |
| Auth | Each agent needs its own token | `clawdi login` once, CLI manages tokens |
| Network dependency | Agent must reach mcp.clawdi.ai | Local IPC, only API calls go over network |
| Agent config | Fill URL+token in each agent's MCP config | `clawdi setup` once, then `clawdi run -- <agent>` |
| Offline | Not possible | Memory can have local cache, partial offline support |

---

## Key Principle

**First-time: `clawdi login && clawdi setup`. Daily use: `clawdi run -- claude`.**

Setup registers the MCP server once. After that, `clawdi run` only handles vault injection — Claude Code spawns the MCP server automatically on every launch.
