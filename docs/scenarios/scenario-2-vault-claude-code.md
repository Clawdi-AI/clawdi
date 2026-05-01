# Scenario 2: Vault + Claude Code (CLI-First)

**Date:** 2026-04-15
**Context:** Vault is Layer 2 infrastructure — secrets never enter LLM context.

---

## Overview

Vault stores API keys and secrets centrally. Distribution is CLI-first via `clawdi run` (env injection into child process). No MCP tool, no `.env` files scattered across machines.

---

## The Problem

A typical project needs many API keys:

```
OPENAI_API_KEY        — Claude Code model calls
ANTHROPIC_API_KEY     — same
STRIPE_SECRET_KEY     — payment API
AWS_ACCESS_KEY_ID     — deploy, S3
DATABASE_URL          — database connection
RESEND_API_KEY        — email service
```

Current pain points:
- One `.env` file per project, scattered everywhere
- Switch machines → reconfigure everything
- Claude Code, Cursor, Codex each need their own setup
- `.env` accidentally committed to git
- Sharing secrets in a team — Slack DMs, insecure

---

## How Vault Solves This

### Step 1: Store Secrets (CLI or Dashboard)

**Via CLI (primary for developers):**

```bash
# Add a single key
clawdi vault set OPENAI_API_KEY
> Enter value: ****
✓ Stored OPENAI_API_KEY

# Add with namespace
clawdi vault set prod/STRIPE_SECRET_KEY
> Enter value: ****
✓ Stored prod/STRIPE_SECRET_KEY

# Import from existing .env file
clawdi vault import .env
✓ Imported 6 keys from .env

# Import with namespace prefix
clawdi vault import .env --namespace prod/
✓ Imported 6 keys under prod/

# List stored keys (values never shown)
clawdi vault list
  ai/OPENAI_API_KEY        last used: 2h ago
  ai/ANTHROPIC_API_KEY     last used: 2h ago
  prod/STRIPE_SECRET_KEY   last used: 1d ago
  prod/AWS_ACCESS_KEY_ID   last used: 3d ago
  prod/DATABASE_URL        last used: 1d ago
  dev/DATABASE_URL         last used: 5m ago

# Remove a key
clawdi vault rm dev/DATABASE_URL
✓ Removed dev/DATABASE_URL
```

**Via Dashboard (for visual management):**

```
Dashboard → Vault → Add Key / Import .env

  Same operations, plus:
  - Audit log viewer (who read what key, when, from which agent)
  - Per-key access control (which agent tokens can read this key)
  - BYO vault connection (1Password, HashiCorp Vault, Infisical)
```

Both CLI and Dashboard write to the same backend — keys added via CLI appear in Dashboard and vice versa.

### Step 2: Auto-Inject at Launch

```bash
$ clawdi run -- claude
```

What happens:

```
clawdi run -- claude
  │
  ├── 1. Fetch vault keys from Clawdi API (HTTPS)
  ├── 2. Set as child process env vars:
  │       OPENAI_API_KEY=sk-xxx
  │       STRIPE_SECRET_KEY=sk_live_xxx
  │       ...
  └── 3. exec(claude)

Claude Code process:
  process.env.OPENAI_API_KEY = "sk-xxx"       ✓ SDK uses directly
  process.env.STRIPE_SECRET_KEY = "sk_live_xxx" ✓ project code uses directly

LLM context:
  Cannot see any secret values  ✓ Secure
```

---

## Usage Scenarios

### A: Selective Key Injection

```bash
# Only AI-related keys
clawdi run --keys ai/* -- claude

# Only dev environment
clawdi run --keys dev/* -- claude

# Exact keys
clawdi run --keys OPENAI_API_KEY,DATABASE_URL -- claude
```

### B: Writing Code That Uses Secrets

```
User: Write a function to create a Stripe subscription

Claude Code:
  → writes stripe.subscriptions.create(...) code
  → code uses os.environ["STRIPE_SECRET_KEY"]
  → tests run immediately — env var already present
  → LLM never sees the actual key value
```

### C: Alternative Distribution Methods

```bash
# Option 2: Pull to local .env file (persists on disk)
clawdi env pull
# → generates .clawdi.env (0600 permissions)
# → .gitignore automatically includes .clawdi.env

# Option 3: Export to current shell (least secure, for quick debugging)
eval $(clawdi env export)

# Option 4: direnv integration (.envrc)
# Auto-load on cd into directory, auto-unload on leave
source <(clawdi env export --format=export)
```

### D: CI/CD Pipelines

```yaml
# GitHub Actions
jobs:
  deploy:
    steps:
      - run: |
          clawdi run --keys prod/* -- ./deploy.sh
        env:
          CLAWDI_AUTH_TOKEN: ${{ secrets.CLAWDI_AUTH_TOKEN }}
```

Only one secret (`CLAWDI_AUTH_TOKEN`) in GitHub Secrets. All other keys pulled from Vault at runtime.

---

## Security Model

### Why Better Than .env Files

```
.env files:
  ├── Plaintext on disk
  ├── Any process that can read files sees them
  ├── git add . can accidentally commit
  └── LLM can cat .env and see contents

clawdi run:
  ├── Secrets only in child process memory, never on disk
  ├── Parent shell env untouched
  ├── Process exits → env vars gone
  ├── LLM context never contains secret values
  └── Audit log records who read what key and when
```

### Encryption at Rest (Server Side)

```
Cloud KMS (AWS KMS / GCP KMS / Phala TEE)
  └── Master Key (never leaves KMS)
       └── User KEK (per user, encrypted by master)
             └── DEK (per secret, encrypted by KEK)
                   └── Secret Value (ciphertext in Postgres)
```

Stolen database dump → useless (everything encrypted).
Stolen app server → useless (can't call KMS without credentials).
User A compromised → User B unaffected (separate KEKs).

---

## Vault vs Connectors

| | Vault | Connectors |
|---|---|---|
| Stores | Static secret strings | OAuth connections (token + refresh) |
| Distribution | Env var injection, `os.environ["KEY"]` | MCP tool call `connector_call(...)` |
| LLM visibility | Never (Layer 2) | Yes, by design (Layer 1) |
| Typical content | API keys, DB URLs, secrets | GitHub/Notion/Linear operation results |
| Consumer | SDK / application code | LLM agent |

---

## Key Principle

**Secrets are infrastructure, not context.** The LLM uses secrets indirectly (SDK reads env vars, HTTP calls go through proxies) but never sees raw values in its conversation history.
