# Scenario 4: Channels — Telegram ↔ Claude Code Bridge

**Date:** 2026-04-15
**Context:** Channels decouple bot tokens from deployments. This scenario focuses on using Telegram to remotely drive Claude Code on your local machine.

---

## Overview

Clawdi Channels unifies IM bot management at the user level (not deployment level). Bot tokens move from OpenClaw deployment config into Clawdi Vault. Any agent — including Claude Code — can send and receive messages.

The most interesting scenario: **use Telegram on your phone to interact with Claude Code running on your dev machine.**

---

## The Problem

Current state:
- Telegram/Discord bot tokens are embedded in OpenClaw deployment config (JSONB)
- Only OpenClaw agents can receive and reply to messages
- Rebuild a deployment → reconfigure bot tokens
- Want Claude Code to send you a Telegram notification? Not possible
- Want to ask Claude Code a question from your phone? Not possible

---

## Channel Management (CLI)

```bash
# Add a Telegram bot
clawdi channel add telegram
> Bot token: ****
> Policy: pairing  (pairing / allowlist / open)
✓ Added Telegram channel "my-telegram"
✓ Bot token stored in Vault (channels/telegram/bot_token)

# Add Discord bot
clawdi channel add discord
> Bot token: ****
✓ Added Discord channel "my-discord"

# List channels
clawdi channel list
  my-telegram   telegram   status: connected   last msg: 5m ago
  my-discord    discord    status: connected   last msg: 2h ago

# Remove
clawdi channel rm my-telegram
```

---

## Scenario A: Outbound — Claude Code Sends Notifications

The simplest use case. Claude Code runs a bash command to send you a message.

```
你: 跑完测试后在 Telegram 通知我

Claude Code:
  → runs: pdm test
  → runs: clawdi channel send my-telegram "✅ Tests passed, 42/42"
  → you receive the notification on your phone
```

No MCP tool needed. Claude Code can run bash, `clawdi channel send` is just a CLI command.

```bash
# CLI usage
clawdi channel send my-telegram "deploy to staging done"
clawdi channel send my-discord "PR #369 merged"
```

---

## Scenario B: Inbound — Telegram Drives Claude Code

This is the interesting one. You're on your phone, you want to check something in your codebase or make a quick change.

### Starting the Bridge

```bash
$ clawdi channel serve my-telegram \
    --agent claude \
    --cwd /Users/paco/workspace/clawdi \
    --allow-users paco

✓ Connected to Telegram bot @clawdi_dev_bot
✓ Listening for messages from: paco
✓ Working directory: /Users/paco/workspace/clawdi
✓ Mode: session (timeout: 10m)
```

### What Happens Under the Hood

Uses `claude -p` (print mode) as a subprocess. Non-interactive — permissions are controlled via `--permission-mode` flag at launch, not during execution.

```
Telegram message from your phone
    ↓
clawdi channel serve (long-running process on your dev machine)
    ↓
Verify sender (allowlist / pairing)
    ↓
Send "🔄 Processing..." reply
    ↓
claude -p "{message}" --cwd {cwd} --permission-mode {mode} [--resume {session_id}]
    ↓
Capture stdout
    ↓
Format output (split if >4096 chars, markdown code blocks)
    ↓
Send reply to Telegram
```

### Example Conversation

```
📱 Telegram:

你: 最近 5 条 commit
🤖: 01ab2e66 fix: increase gateway RPC timeout
    1e957426 fix: trust backend entitled flag
    e22b2bb0 feat: hermes composio MCP
    423e7ab5 chore: bump agent image
    9f3a21b8 fix: channel disconnect race condition

你: backend/app/routes/config.py 有多少行
🤖: 2,247 行

你: 有没有 channel 相关的 TODO
🤖: 找到 3 处:
    config.py:892  # TODO: validate bot token format
    config.py:1034 # TODO: handle disconnect timeout
    channels.py:45 # TODO: add rate limiting

你: 帮我跑一下 pdm lint
🤖: ✅ Ruff lint passed, 0 errors

你: /new
🤖: ✓ 新会话已开始
```

---

## Permission Handling

Claude Code normally prompts for user approval in the terminal. In `claude -p` (print mode), there's no terminal — but **it won't hang**. Permissions are decided at launch via `--permission-mode`:

| `--permission-mode` | Behavior | Use case |
|---------------------|----------|----------|
| `dontAsk` | Only uses tools listed in `--allowedTools`, silently denies the rest | Read-only queries |
| `acceptEdits` | Auto-approves file edits, other tools follow default rules | Light code changes |
| `bypassPermissions` | Everything auto-approved | Full trust, sandbox |
| `default` | Unapproved tools are denied (Claude adapts or reports it can't) | Safe fallback |

### Permission Modes in Channel Serve

```bash
# 1. Read-only (default — safe for phone queries)
clawdi channel serve my-telegram --agent claude --permission read-only
# → claude -p --permission-mode dontAsk --allowedTools "Read,Grep,Glob,Bash(git log*),Bash(git diff*),Bash(ls*)"
# Best for: checking code, viewing logs, searching files

# 2. Edit mode (auto-approve file edits + reads)
clawdi channel serve my-telegram --agent claude --permission edits
# → claude -p --permission-mode acceptEdits
# Best for: making code changes from your phone

# 3. Full access (everything auto-approved)
clawdi channel serve my-telegram --agent claude --permission full
# → claude -p --permission-mode bypassPermissions
# ⚠️ High risk — only use in trusted environments
```

No SDK needed. `claude -p` handles permissions cleanly in non-interactive mode — unapproved operations are denied, not blocked.

### Optional Enhancement: SDK for Interactive Approvals

For a richer experience, the Claude Code SDK (`@anthropic-ai/claude-code`) provides a `canUseTool` callback that can forward each permission request to Telegram as inline buttons (Allow/Deny). This is optional — the `claude -p` approach covers most use cases without the added complexity.

---

## Session Management

### Stateless Mode

```bash
clawdi channel serve my-telegram --agent claude --session stateless
```

Each message is an independent `claude -p` call:

```
Message 1 → claude -p "最近 5 条 commit"          → no context
Message 2 → claude -p "第三条是什么意思"           → doesn't know what "第三条" refers to
```

- Pros: Simple, no state management, each request is isolated
- Cons: No multi-turn context, can't say "change that function" after "show me that file"

### Session Mode (Multi-Turn Context)

```bash
clawdi channel serve my-telegram --agent claude --session persistent --session-timeout 10m
```

Uses `claude -p --resume` to maintain conversation context:

```
Message 1 → claude -p "最近 5 条 commit"
          → output + session_id = "abc123"

Message 2 → claude -p "第三条是什么意思" --resume abc123
          → has full context from message 1

(10 min idle → session expires)

Message 3 → claude -p "另一个问题"
          → new session_id = "def456"
```

Internal state mapping:

```
telegram_user_id → {
  session_id: "abc123",
  last_active: "2026-04-15T10:30:00Z",
  cwd: "/Users/paco/workspace/clawdi"
}
```

Telegram commands for session control:

| Command | Action |
|---------|--------|
| `/new` | End current session, start fresh |
| `/status` | Show current session info (cwd, uptime, session age) |
| `/project clawdi` | Switch working directory (if project aliases configured) |
| `/cancel` | Cancel currently running Claude Code process |

---

## Practical Concerns

### Response Latency

Claude Code is not instant — typical response takes 5-60 seconds.

```
Strategy:
  1. Immediately reply "🔄 Processing..."
  2. For long-running tasks, send progress updates every 30s
     "⏳ Still working... (reading 12 files)"
  3. Timeout after configurable limit (default 120s)
     "⏰ Timed out. Partial result: ..."
```

### Telegram Message Length

Telegram limits messages to 4,096 characters.

```
Strategy:
  - Short output (<4096): send as-is with markdown formatting
  - Medium output (4096-20000): split into multiple messages
  - Long output (>20000): send summary + save full output to file
    "📄 Full output saved: clawdi channel get-output {id}"
  - Code blocks: use Telegram ``` formatting
```

### Concurrency

```bash
# Process one message at a time (safe default)
clawdi channel serve my-telegram --agent claude --concurrency 1
# → queues additional messages: "📋 Queued (position 2)"

# Allow parallel (multiple Claude Code processes)
clawdi channel serve my-telegram --agent claude --concurrency 3
# → careful: multiple processes modifying same codebase
```

### Security

This runs Claude Code on your local machine with your permissions. Treat it seriously.

```
1. Sender verification
   --allow-users paco           # Telegram username allowlist
   --pairing                    # Require /pair command with code first

2. Permission boundaries (see "Permission Handling" section above)
   --permission read-only       # Default: only read operations
   --permission edits           # Auto-approve file edits
   --permission full            # Everything auto-approved (⚠️ risky)

3. Working directory
   --cwd /path/to/project       # Lock to specific directory

4. Network
   clawdi channel serve runs locally, connects outbound to Telegram API
   No inbound ports needed (long polling mode)
```

### Multiple Projects

```bash
# Configure project aliases
clawdi channel serve my-telegram --agent claude --projects '{
  "clawdi": "/Users/paco/workspace/clawdi",
  "btc": "/Users/paco/workspace/btc-pattern-search",
  "web": "/Users/paco/workspace/clawdi/apps/web"
}'

# In Telegram:
你: /project clawdi
🤖: ✓ Switched to clawdi (/Users/paco/workspace/clawdi)

你: 最近改了什么
🤖: (shows clawdi recent changes)

你: /project btc
🤖: ✓ Switched to btc (/Users/paco/workspace/btc-pattern-search)
```

---

## Architecture

```
📱 Phone (Telegram)
    │
    │ Telegram Bot API (outbound long polling, no inbound ports)
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  clawdi channel serve (long-running on dev machine)  │
│                                                      │
│  ┌────────────────┐    ┌──────────────────────────┐  │
│  │ Telegram Client │    │ Session Manager          │  │
│  │                │    │                          │  │
│  │ recv message ──┼──→ │ telegram_user → session  │  │
│  │                │    │ timeout tracking         │  │
│  │ send reply ←───┼──  │ concurrency queue        │  │
│  └────────────────┘    └──────────┬───────────────┘  │
│                                   │                  │
│                                   ▼                  │
│                        ┌──────────────────────┐      │
│                        │ claude -p "{msg}"    │      │
│                        │ --permission-mode .. │      │
│                        │ --resume {session}   │      │
│                        │ --cwd {project_dir}  │      │
│                        │                      │      │
│                        │ reads: CLAUDE.md,    │      │
│                        │ MCP servers,         │      │
│                        │ local files, git     │      │
│                        └──────────────────────┘      │
│                                                      │
│  Bot token: from Vault (clawdi channel add)          │
│  Auth: from ~/.clawdi/config (clawdi login)          │
└──────────────────────────────────────────────────────┘
```

---

## Comparison: Telegram via OpenClaw vs Clawdi Channel Serve

| | OpenClaw + Telegram | clawdi channel serve |
|---|---|---|
| Runs where | Cloud (Phala CVM / k3s) | Your local dev machine |
| Code access | None (cloud agent) | Full local codebase |
| Tools | OpenClaw browser, MCP tools | Claude Code full toolset (bash, file edit, git, MCP) |
| State | Always on, persistent | On-demand, you start/stop it |
| Use case | Customer-facing bot, automated tasks | Developer remote access to own workspace |
| Latency | Fast (cloud, always warm) | Slower (local, cold start per message in stateless mode) |
| Bot token | In deployment config | In Clawdi Vault |

They serve different purposes. OpenClaw Telegram is a product-facing agent. `clawdi channel serve` is a developer tool — remote access to your dev environment from your phone.

---

## Why Not MCP for Channels

From the design doc:
- **Sending** is a side effect, not LLM context enrichment → `clawdi channel send` CLI is sufficient
- **Receiving** is push-based, not something the LLM should poll → long-polling handled by `clawdi channel serve`
- Claude Code can run bash commands, so CLI tools are the natural interface

---

## Key Principle

**Channels are infrastructure, not agent features.** Bot tokens live in Vault, routing lives in Clawdi, any agent can send/receive. The `channel serve` command turns any CLI agent into a Telegram bot without the agent knowing or caring about Telegram.
