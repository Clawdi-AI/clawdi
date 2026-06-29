# AI Provider Isolated Smoke Record

This document records the Docker-isolated smoke test for the first non-UI AI
Provider slice.

## Re-run Command

Run from the repository root:

```bash
scripts/ai-provider-isolated-smoke.sh
```

The script mounts the repository read-only, copies it into the container, and
uses container-local homes and state directories. It does not install agent CLIs
or Python packages on the host machine.

## Recorded Run

- Date: 2026-06-03
- Branch: `feat/ai-provider-abstraction`
- Latest rerun: 2026-06-04 after source/target apply and Codex OAuth
  target-native auth store changes
- Container image: `node:24-bookworm-slim`
- Container-only installs:
  - `bun@1.3.14`
  - `@openai/codex@0.136.0`
  - `openclaw@2026.6.1`
  - `hermes-agent==0.15.2`
  - Debian `git`, `python3`, and `python3-venv`
- Repository mount: read-only at `/repo`
- Runtime copy: `/tmp/repo` inside the container
- CLI workspace install: temporary container-only workspace containing only
  `packages/cli` and `packages/shared`
- Fake provider: local OpenAI-compatible server at
  `http://127.0.0.1:18080/v1`
- Test secret: fake value `sk-smoke-secret-value`

## Covered User Flows

1. Add an env-backed OpenAI provider with `clawdi ai-provider add`.
2. Run default `clawdi ai-provider test`; auth is checked and live probe is
   skipped by default.
3. Run optional `clawdi ai-provider test --live`; the fake provider receives
   `GET /v1/models`.
4. Export with `--include-secrets --secret-passphrase`; the encrypted export and
   CLI output do not contain the plaintext secret.
5. Import into a second isolated home with `--import-secrets env-file`.
6. Apply Codex config and verify the generated profile preserves the user's
   primary `$CODEX_HOME/config.toml`.
7. Run real `codex exec --profile clawdi-ai-provider` against the fake provider;
   the fake provider receives `POST /v1/responses`.
8. Apply Hermes config and load it through the real `hermes-agent` package;
   existing `mcp_servers` config is preserved.
9. Apply OpenClaw config through the real OpenClaw CLI and read it back with
   `openclaw config get`.
10. Add a Codex OAuth source backed by a fake Clawdi auth-resolve endpoint, then
    run `clawdi ai-provider apply openai-codex` with the default target set.
11. Verify target-native Codex OAuth auth stores are written for Codex, Hermes,
    and OpenClaw. The OpenClaw auth profile is the canonical
    `openai:default` entry with `order.openai`.
12. Assert fake env secrets and fake OAuth tokens are not present in Clawdi CLI
    output or generated non-secret runtime config.
13. Assert the fake secret is not present in Clawdi CLI output, generated
    runtime config, or the smoke summary.

## Automated But Not Smoke-Covered

Codex OAuth is covered by CLI and backend tests, but it is not part of this
Docker smoke run.

Covered by automated tests:

- Backend-generated Codex authorization URL with the pinned OpenAI OAuth
  client ID, scopes, PKCE challenge, loopback redirect, and extra Codex
  authorize parameters.
- Backend token completion path with state validation, redirect URI validation,
  token exchange, Codex `auth.json` envelope generation, encrypted storage, and
  redacted API responses.
- CLI `ai-provider connect --tool codex` loopback callback flow.
- CLI fallback from callback port `1455` to `1457`.
- CLI manual paste flow through `ai-provider complete-oauth`.
- OAuth provider error handling, which must not complete auth or replace the
  provider's existing auth.
- Backend route coverage for Codex auth profile import/resolve and OAuth
  start/complete is covered by `backend/tests/test_ai_providers.py`.

Not covered by automated smoke:

- A real browser authorization against OpenAI.
- A real OpenAI token exchange using a user's account.
- Refreshing an expired Codex OAuth token after materialization.

Those checks require an interactive OpenAI account and should be run as a
manual pre-release acceptance test, not as a blocking CI smoke.

## Real Codex OAuth Acceptance

Recorded on 2026-06-03 with `@openai/codex@0.136.0`:

1. Ran Clawdi backend locally on `127.0.0.1` with a development-only auth
   context and isolated `$CLAWDI_HOME` / `$CODEX_HOME`.
2. Created an `openai` provider and started Codex OAuth through
   `clawdi ai-provider connect --tool codex --callback manual`.
3. Opened the backend-generated OpenAI authorization URL in a real browser and
   completed authorization with a real OpenAI account.
4. Completed OAuth through `clawdi ai-provider complete-oauth`.
5. Verified the provider auth changed to `agent_profile` for `codex/default`.
6. Created a temporary CLI API key for the same local test user and ran
   `clawdi ai-provider apply openai-codex --target codex`.
7. Verified the isolated Codex profile and `auth.json` were written with mode `0600`,
   `auth_mode: "chatgpt"`, and OAuth token fields.
8. Verified the generated Codex profile uses `model_provider = "openai"` and
   omits `model`, allowing Codex to choose its ChatGPT-account-compatible
   default model.
9. Ran real `codex exec --profile clawdi-ai-provider` without
    `OPENAI_API_KEY`; Codex used `model: gpt-5.5` and returned the expected
    response.

Important finding: writing `model = "gpt-5.2"` into a Codex OAuth profile
caused Codex to fail with a real OpenAI error because that API model is not
supported for the tested ChatGPT Codex account. AI Provider apply therefore
omits `model` for the built-in OpenAI Codex OAuth provider.

## Version Compatibility Audit

Recorded on 2026-06-03 in Docker containers with container-local homes and
package caches:

- Codex: `@openai/codex@0.134.0`, `0.135.0`, and `0.136.0` each started,
  exposed `--profile <CONFIG_PROFILE_V2>`, and accepted
  `$CODEX_HOME/clawdi-ai-provider.config.toml`.
- Hermes: `hermes-agent==0.13.0`, `0.14.0`, `0.15.0`, `0.15.1`, and `0.15.2`
  each loaded a v12 `providers` dict from `config.yaml` and resolved
  `custom:openai-main` with Hermes' Responses transport and `key_env` auth.
- OpenClaw: `openclaw@2026.5.12`, `2026.5.18`, `2026.5.27`, and
  `2026.5.28` each accepted the AI Provider patch shape through
  `openclaw config patch --stdin --dry-run --json`.
- OpenClaw: `openclaw@2026.6.1` accepted the env-backed AI Provider patch shape
  through the real `openclaw config patch --stdin` path and used the canonical
  `openai:default` auth profile for Codex OAuth target-native apply.

Latest source/package audit recorded on 2026-06-29:

- Codex: `@openai/codex@0.142.4` still exposes profile-v2 config files,
  `model_providers`, `wire_api = "responses"`, `env_key`, and
  `requires_openai_auth`.
- Hermes: `hermes-agent==0.17.0` still supports the v12 `providers` dict,
  `custom:<provider-id>` resolution, the target-native Responses transport,
  `openai-codex`, and `credential_pool.openai-codex`.
- OpenClaw: `openclaw@2026.6.10` still supports
  `openclaw config patch --stdin`, `models.providers`, env SecretRefs, and
  canonical `openai/<model>` routes. Clawdi projects API-key Responses
  providers directly with `api: "openai-responses"` and reserves the native
  `openai/<model>` route for Codex OAuth.

## Backend Docker Postgres Check

Recorded on 2026-06-04:

1. Started an isolated Compose Postgres service from `pgvector/pgvector:pg16`
   with a throwaway project name and volume.
2. Enabled `vector` and `pg_trgm`.
3. Ran `uv run alembic upgrade head`.
4. Ran `uv run pytest tests/test_ai_providers.py`.
5. Removed the Compose project and volume.

Result: `14 passed`.

## Final Result

The recorded isolated run exited with code `0` and printed:

```json
{
  "ok": true,
  "image": "node:24-bookworm-slim",
  "bun": "1.3.14",
  "codex": "0.136.0",
  "openclaw": "2026.6.1",
  "hermes": "0.15.2",
  "addProvider": "openai-main",
  "defaultProbe": "skipped",
  "liveProbe": "ok",
  "importedProviders": 1,
  "codexProfileWritten": true,
  "codexExecReachedFakeProvider": true,
  "codexExecOutput": "clawdi smoke ok",
  "hermesConfigLoadedByHermes": true,
  "hermesTransport": "codex_responses",
  "hermesMcpPreserved": true,
  "openclawDefaultModel": "openai-main/gpt-5.2",
  "openclawProviderApi": "openai-responses",
  "openclawModels": ["gpt-5.2"],
  "codexOauthTargets": ["codex", "hermes", "openclaw"],
  "codexOauthProfileUsesBuiltInOpenAI": true,
  "codexOauthAuthStoresWritten": ["codex", "hermes", "openclaw"],
  "openclawOauthProfile": "openai:default",
  "openclawOauthDefaultModel": "openai/gpt-5.2",
  "backendAuthResolveCalls": 3,
  "fakeProviderRequests": [
    "GET /v1/models",
    "POST /v1/responses",
    "POST /api/ai-providers/openai-codex/auth/resolve",
    "POST /api/ai-providers/openai-codex/auth/resolve",
    "POST /api/ai-providers/openai-codex/auth/resolve"
  ],
  "secretLeakedInOutputs": false
}
```

## Notes

The smoke does not require a real API key. It uses a local fake
OpenAI-compatible provider so the direct runtime path can be verified without
billing, rate limits, or external account state. A real provider probe is still
useful as an optional pre-release check, but it should not be a blocking CI
requirement.

Claude Code AI Provider apply is intentionally unsupported in this slice.
