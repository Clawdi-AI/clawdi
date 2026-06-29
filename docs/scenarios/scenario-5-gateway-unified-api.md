# Scenario 5: Managed API Gateway

**Date:** 2026-04-15
**Context:** A managed API gateway can provide a zero-config fallback when a
user does not bring provider keys through Vault.

---

## Overview

Clawdi can support two provider access paths:

1. **Vault / BYOK**: the user stores provider keys in Vault, and `clawdi run`
   injects them into the agent process.
2. **Managed gateway**: Clawdi injects a gateway token and provider-compatible
   base URL when the user has no matching Vault key.

The gateway implementation, routing provider, billing backend, and production
deployment details are outside this open-source scenario.

## User Paths

```
User needs to call LLM / search / transcription APIs
  |
  |-- Vault path
  |   User has provider keys -> Vault injects them -> provider bills user
  |
  `-- Managed path
      User has no provider key -> gateway token is injected -> Clawdi bills user
```

The paths are not mutually exclusive. `clawdi run` can resolve each provider
independently.

## Example: New User

```bash
clawdi auth login
clawdi setup
clawdi run -- claude
```

Expected behavior:

- no matching provider key exists in Vault;
- Clawdi injects a managed provider token;
- Clawdi sets the provider-compatible base URL;
- usage is deducted from the user's Clawdi balance.

## Example: BYOK User

```bash
clawdi vault set ANTHROPIC_API_KEY
clawdi vault set OPENAI_API_KEY
clawdi run -- claude
```

Expected behavior:

- matching keys exist in Vault;
- `clawdi run` injects the Vault values;
- traffic goes directly to the configured providers;
- Clawdi does not charge managed gateway usage for those calls.

## Direct SDK Shape

Custom scripts should use normal provider SDK configuration:

```python
import openai

client = openai.OpenAI(
    base_url="https://gateway.example.test/openai/v1",
    api_key="clawdi_..."
)
```

The concrete production URL is deployment-specific and should not be hardcoded
in open-source development docs.

## Principle

The gateway is a zero-friction fallback. Vault remains the power-user override.
Users should not need to understand internal gateway infrastructure to choose
the right path.
