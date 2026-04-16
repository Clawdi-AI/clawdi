# Scenario 5: Gateway — Unified API Proxy (Vault Fallback)

**Date:** 2026-04-15
**Context:** Gateway wraps the existing sub2api service with Clawdi token auth. It serves as the automatic fallback when users don't have their own API keys in Vault.

---

## Overview

Gateway is not a new service — it's the existing sub2api (already in production) wrapped with Clawdi token authentication, usage tracking, and billing. Its role in Clawdi 2.0: **the zero-config path for API access.** Users who have their own API keys use Vault; users who don't (or don't want to manage keys) use Gateway automatically.

---

## The Two Paths

```
User needs to call LLM / search / transcription APIs
  │
  ├── Path A: Vault (BYO Keys)
  │   User has their own API keys → stored in Vault → injected by clawdi run
  │   User pays each provider directly
  │
  └── Path B: Gateway (Managed)
      User has no keys / doesn't want to manage them → Clawdi Gateway
      One Clawdi account, Clawdi bills unified
```

These paths are **not mutually exclusive** — `clawdi run` chooses automatically per key.

---

## Automatic Fallback in `clawdi run`

```bash
clawdi run -- claude
  │
  │ For each API key environment variable:
  │
  ├── ANTHROPIC_API_KEY
  │     Vault has it? → inject Vault value, direct connect to Anthropic
  │     Vault empty?  → inject Gateway token + ANTHROPIC_BASE_URL
  │
  ├── OPENAI_API_KEY
  │     Vault has it? → inject Vault value, direct connect to OpenAI
  │     Vault empty?  → inject Gateway token + OPENAI_BASE_URL
  │
  └── Other service APIs (search, transcription, etc.)
      → always via Gateway (no individual keys for these)
```

**Users don't choose between Vault and Gateway.** `clawdi run` resolves it automatically. Have your own key? Use it. Don't? Gateway handles it.

---

## Product Scenarios

### A: New User, Zero Config

```bash
# Sign up for Clawdi, no API keys at all
clawdi login
clawdi setup

# Just use it — Gateway fills in automatically
clawdi run -- claude
# → No ANTHROPIC_API_KEY in Vault
# → Auto-injects:
#      ANTHROPIC_BASE_URL=https://api.clawdi.ai/anthropic/v1
#      ANTHROPIC_API_KEY=<clawdi_token>
# → Claude Code works immediately
# → Usage deducted from Clawdi balance
```

Zero friction onboarding — sign up, `clawdi run`, done. No need to register at Anthropic/OpenAI first.

### B: Power User, BYO Keys

```bash
# Has own keys, stores in Vault
clawdi vault set ANTHROPIC_API_KEY
clawdi vault set OPENAI_API_KEY

clawdi run -- claude
# → Vault has ANTHROPIC_API_KEY → inject it, direct connect
# → No Gateway involved, no Clawdi balance deducted
```

### C: Mixed Mode

```bash
# Only has Anthropic key in Vault
clawdi vault set ANTHROPIC_API_KEY

clawdi run -- python my_agent.py
# Agent code calls Anthropic → uses Vault key, direct connect
# Agent code calls OpenAI    → no Vault key → Gateway fallback
# Agent code calls search API → no Vault key → Gateway fallback
```

Per-service automatic resolution. No config needed.

### D: Direct Gateway Usage (Without clawdi run)

```python
# For custom agents / scripts — use Clawdi token directly
import openai

client = openai.OpenAI(
    base_url="https://api.clawdi.ai/openai/v1",
    api_key="clawdi_agt_v1_xxx"  # Clawdi token, not OpenAI key
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}]
)
```

```python
# Same token for Anthropic
import anthropic

client = anthropic.Anthropic(
    base_url="https://api.clawdi.ai/anthropic/v1",
    api_key="clawdi_agt_v1_xxx"  # same Clawdi token
)
```

One token, all providers. Standard OpenAI/Anthropic SDK, just swap `base_url`.

### E: Team Unified Billing

```
CTO tops up Clawdi with $500
  → Issues agent tokens to each developer
  → Developers use tokens in their agents / scripts / Claude Code
  → Dashboard shows per-person per-model usage
  → One invoice, no individual expense reports
```

---

## CLI Commands

```bash
# List available models and services
clawdi gateway models
  anthropic/claude-opus-4      ✓
  anthropic/claude-sonnet-4    ✓
  openai/gpt-4o               ✓
  openai/o3                   ✓
  deepseek/deepseek-r1         ✓
  search (Brave/Exa/Serper)    ✓
  transcribe (Whisper)         ✓
  images (DALL-E/Flux)         ✓

# Check usage
clawdi gateway usage
  This month:
    claude-opus-4     $12.30  (142 requests)
    gpt-4o            $3.20   (89 requests)
    search            $0.50   (200 requests)
    Total:            $16.00

# Check balance
clawdi gateway balance
  Balance: $83.50
  Auto-recharge: $50 when below $10
```

---

## Relationship to sub2api

```
Current:
  sub2api runs independently with its own token system
  Users manage sub2api tokens directly

Clawdi 2.0:
  sub2api becomes Gateway's backend engine
  Users access it via Clawdi tokens (gateway:call scope)
  Clawdi handles: token auth → scope check → usage tracking → proxy to sub2api
  sub2api is transparent to users

  Clawdi Token → Clawdi API Gateway → sub2api → OpenAI/Anthropic/Brave/...
```

sub2api requires minimal changes — Clawdi adds a proxy layer in front.

---

## Gateway Endpoints

```
https://api.clawdi.ai/openai/v1/*        → OpenAI-compatible (drop-in base_url)
https://api.clawdi.ai/anthropic/v1/*     → Anthropic-compatible (drop-in base_url)
https://api.clawdi.ai/v1/search          → Unified search (Brave/Exa/Serper routing)
https://api.clawdi.ai/v1/transcribe      → Audio transcription (Whisper)
https://api.clawdi.ai/v1/images          → Image generation
https://api.clawdi.ai/v1/twitter/*       → Twitter/X API proxy
```

All endpoints accept `Authorization: Bearer {clawdi_token}`. Scope required: `gateway:call`.

---

## Key Principle

**Gateway is the zero-friction default. Vault is the power-user override.** New users start with Gateway (no keys to manage), power users bring their own keys via Vault. `clawdi run` resolves the path automatically — users never configure which to use.
