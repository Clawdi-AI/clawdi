# Architecture Review — Known Issues Log

> Captured from a dual-track review (Claude Code Explore + Codex) on 2026-04-23
> on branch `research/physical-deploy`.
>
> Status as of 2026-04-23 end-of-day: most of the BLOCKER + HIGH + LOW items
> from this review have been closed. See the per-item ✅/⚠️/❌ markers below.
>
> This file remains the backlog — don't re-open a closed item without a
> focused PR that links back to it.

## Overall grades

| Axis | Claude | Codex | Take |
|---|---|---|---|
| Module boundaries | A | B− | B |
| Type safety end-to-end | A− | C+ | **B−** (Codex caught CLI manual types + `unknown` response) |
| Security | B+ | C | **C+** (Codex caught connector ownership bug) |
| Testability + coverage | B− | B− | B− |
| DX | B | C+ | B− |
| Scaling traps | C+ | C | C+ |
| **Overall** | B+ | C+ | **B−** |

---

## 🚨 BLOCKER — ship-stoppers for multi-tenant production

### 1. ✅ Connector DELETE does not verify ownership  *(closed: 6120597)*

- **Where:** `backend/app/routes/connectors.py:63-72`, `backend/app/services/composio.py:115-127`
- **Issue:** `DELETE /api/connectors/{connection_id}` removes a Composio connection without checking `auth.user_id`. User A can pass user B's `connection_id` and delete B's connection.
- **Fix direction:** Load the connection first, assert `connection.user_id == auth.user_id`, return 404 otherwise. Add a regression test matching the `test_revoke_other_users_key_is_404` pattern already in `backend/tests/test_auth_keys.py`.

### 2. ✅ Session batch ingest lacks uniqueness guarantee  *(closed: 6120597)*

- **Where:** `backend/app/routes/sessions.py:98-108`, `backend/app/models/session.py:24-30`
- **Issue:** Batch sync does `SELECT ... WHERE local_session_id = ?` for every incoming row before insert, and `(user_id, local_session_id)` has no unique constraint. Concurrent CLI invocations can race and insert duplicates.
- **Fix direction:** Alembic migration adds `UniqueConstraint(user_id, local_session_id)`. Switch the route to `ON CONFLICT DO UPDATE` (Postgres upsert). Drop the pre-check SELECT.

### 3. ✅ MCP proxy JWT falls back to `VAULT_ENCRYPTION_KEY`  *(closed: 6120597)*

- **Where:** `backend/app/services/composio.py:41-60`
- **Issue:** When `ENCRYPTION_KEY` is unset the code signs MCP tokens with `VAULT_ENCRYPTION_KEY`, erasing the deliberate "separate keys for separate concerns" boundary documented in `CLAUDE.md`.
- **Fix direction:** `Settings.encryption_key` → required in production (add a `@model_validator` or runtime assertion at startup). Remove the fallback entirely.

---

## HIGH — contract + abstraction debt

### 4. ✅ Skill marketplace install bypasses tar validation  *(closed: 326d3a7)*

- **Where:** `backend/app/routes/skills.py:252-290`, `backend/app/services/skill_installer.py:98-169`
- **Issue:** The `POST /api/skills/install` path builds a tar from remote GitHub content without the file-count / size / path-traversal checks that `POST /api/skills/upload` already has.
- **Fix direction:** Share a `_validate_tar` helper and call it from both paths. Pair with `test_skill_upload_rejects_path_traversal`-style tests.

### 5. ✅ FileStore abstraction leaks — `LocalFileStore` hardcoded in routes  *(closed: 326d3a7)*

- **Where:** `backend/app/routes/sessions.py:27`, `backend/app/routes/skills.py:31`
- **Issue:** The `FileStore` class exists but routes bypass it and instantiate `LocalFileStore` directly. The S3/R2 switch in `CLAUDE.md` is aspirational — nothing actually reads `FILE_STORE_TYPE`.
- **Fix direction:** Move store construction to `app/core/deps.py` (or `app/services/file_store.py` factory), read from `Settings`, inject via FastAPI dependency. Add a `test_file_store_factory_selects_backend` test.

### 6. ✅ `GET /api/sessions/{id}/content` has no Pydantic response model  *(closed: 326d3a7)*

- **Where:** `backend/app/routes/sessions.py:209-234`, `apps/web/src/lib/api-types.generated.ts:1574-1592`
- **Issue:** Route returns raw dict; OpenAPI generates `unknown`; Dashboard defines a `SessionMessage` interface locally and casts. Any backend change silently diverges from frontend.
- **Fix direction:** Add `SessionMessageResponse` Pydantic model. Set `response_model=list[SessionMessageResponse]`. Re-run `bun run generate-api`. Delete the manual interface.

### 7. ✅ CLI maintains its own `api-types.ts` by hand  *(closed: 326d3a7)*

- **Where:** `packages/cli/src/lib/api-types.ts:1-3`
- **Issue:** Hand-written interfaces with a "keep in sync with backend" comment. Drift is institutionalized.
- **Fix direction:** Move generated types into `packages/shared/src/api/` so both the CLI and the web app consume the same file. Delete the CLI shadow file.

### 8. ✅ FileStore methods marked `async` but use blocking local IO  *(closed: 326d3a7)*

- **Where:** `backend/app/services/file_store.py:21-27`
- **Issue:** `await store.put(...)` runs synchronous disk writes on the event loop, stalling other requests under load.
- **Fix direction:** Wrap the local-FS calls in `asyncio.to_thread(...)`, or switch to `aiofiles`. Leave the S3/R2 implementation async-native.

### 9. ✅ `fastembed` downloads 1 GB on the first `memory add` request  *(closed: 326d3a7)*

- **Where:** `backend/app/services/embedding.py:51-58`
- **Issue:** First authenticated `POST /api/memories` triggers a multi-minute cold start while the ONNX model downloads, blocking the request.
- **Fix direction:** Warm the model in an ASGI lifespan startup hook when `MEMORY_EMBEDDING_MODE=local`. Or gate memory creation behind a background task and return 202.

---

## MEDIUM — perf + ops

### 10. ✅ Dashboard streak calculation  *(non-issue on inspection)*

- `dashboard.py:180` already has `if not dates: return 0, 0` — the IndexError concern was a false alarm from the review.
- Python loop over distinct dates is fine up to years of activity. A user
  with 3 k unique active days still loads in <1 ms. Not a scaling trap.

### 11. ✅ Memory embed-backfill loads all IDs at once  *(intentional per code comment)*

- `memories.py:110-121` documents in-source why the snapshot is correct:
  each successful embed removes its row from `WHERE embedding IS NULL`,
  so iterating a live offset would skip rows. Snapshotting 10 k UUIDs
  is ~160 KB — trivial. Leaving as-is.

### 12. ✅ `api_key.last_used_at` — write per request  *(throttled to 1/min)*

- `core/auth.py` now only UPDATE+commit when the previous write was more
  than `LAST_USED_THROTTLE = 1 minute` ago. Good enough for a liveness
  signal on the API key row without flushing on every request.

### 13. ⚠️ Clerk public key is static  *(deferred — intentional for v1)*

- Still true: `Settings.clerk_pem_public_key` is read at import time.
- Clerk rotates keys rarely (years). For MVP a redeploy on rotation is
  acceptable. Track as follow-up: fetch `<issuer>/.well-known/jwks.json`
  with a TTL-cached in-process client.

### 14. ⚠️ No rate limiting on auth endpoints  *(deferred — infrastructure item)*

- Still true: `/api/auth/keys` has no application-layer rate limit.
- Adding slowapi + Redis in-process is scope creep for v1 ship. The
  production front-door should carry rate limits (Cloudflare / nginx
  / API gateway) regardless. Track here for later.

---

## LOW — polish / hardening

### 15. ✅ `.env.example` stale  *(closed in this batch)*

- FILE_STORE_TYPE now wired through Settings and read by the factory.
- Comments all moved to their own lines; pydantic-settings no longer
  parses trailing comments as values.
- Both encryption keys documented with their generator command and an
  explicit "must be different" note.

### 16. ✅ Clerk middleware `protectedRoutes` not explicit  *(closed in this batch)*

- `apps/web/src/proxy.ts` now declares `isProtectedRoute` as a positive
  matcher alongside `isPublicRoute`. Dashboard + /api/ routes are named
  explicitly so the protection is self-documenting.

---

## Green flags

- **Dual-auth boundary** (`backend/app/routes/vault.py:168-189` and `test_vault_resolve_requires_cli_auth` in `backend/tests/test_vault.py`) — `require_cli_auth` dependency makes the CLI-only constraint mechanical and tested.
- **Agent adapter pattern** (`packages/cli/src/adapters/base.ts:36-49`) — Claude Code / Codex / Hermes / OpenClaw integrations are cleanly isolated, not sprayed through command logic.
- **Schema → TS type flow for the web app** — Pydantic → OpenAPI → `api-types.generated.ts` → `api-schemas.ts` works end-to-end for the dashboard (modulo findings #6 and #7).

## Red flags — six-month time bombs

1. **Storage layer** is single-node local FS despite aspirational S3/R2 support. Will block any multi-pod deployment (finding #5 + #8).
2. **Contract drift** already exists in three places (generated types, unresponse-modeled endpoints, CLI hand-written types). API iteration speed will amplify this fast (#6, #7).
3. **Isolation / race defenses live in Python, not the DB.** Multiple routes rely on SELECT-then-INSERT patterns without unique constraints — today these are races; at scale they are duplicate-data bugs (#2).

---

## Not doing this sprint

This file exists so the above stays visible. Do NOT land any of these fixes without opening a focused PR that cites the item number, adds a regression test, and crosses the item off this list.
