# Clawdi Vault Password Manager Research

**Status:** research complete; architecture direction proposed
**Last updated:** 2026-05-19
**Owner:** product + platform

## Summary

Clawdi should not replace its Vault product surface with OpenBao, Infisical,
Bitwarden, or another external secrets product. The product direction should
be a Clawdi-native password-manager experience:

- 1Password-style secret references, `read`, `run`, and `inject`.
- Bitwarden/1Password-style client-side encrypted vault data for user-owned
  secrets.
- Clawdi-specific Project, Agent Project, attachment order, and conflict
  semantics.
- Agent-specific runtime controls: lease/TTL, kill switch, audit, and optional
  credential proxy or TEE-backed runtime for hosted agents.
- OpenBao or cloud KMS only as a key-operations adapter for server-managed
  keys, legacy migration, rotation, rewrap, and audit hardening.

The product promise should evolve in two steps:

1. **Password-manager workflow:** users stop putting plaintext secrets in
   `.env`, code, scripts, and agent setup files.
2. **Password-manager trust model:** Clawdi cannot decrypt ordinary user vault
   data because encryption keys are held client-side or inside an attested
   runtime.

Do not claim zero-knowledge or "Clawdi cannot see your secrets" until the
second step ships.

## Current State

Today Clawdi Vault is server-side encrypted:

- Secret values are stored in PostgreSQL `vault_items`.
- Values are AES-256-GCM encrypted by `backend/app/services/vault_crypto.py`.
- The master key is `VAULT_ENCRYPTION_KEY` in backend process config.
- `/api/vault/resolve` decrypts values server-side and returns plaintext to
  CLI/API-key callers.
- `clawdi run` fetches a Project's resolved environment map and spawns a child
  process with those values in `env`.

This is a reasonable early server-side encryption design, but it is not a
commercial password-manager trust model:

- A backend process with the master key can decrypt user vault values.
- An operator with DB access plus `VAULT_ENCRYPTION_KEY` can decrypt values.
- A backend compromise can become a vault compromise.
- There is no key rotation, no rewrap workflow, no first-class audit trail, no
  item versioning, and no lease/killswitch model.

The strong product semantics already live in Clawdi, not in the crypto helper:

- Project membership and sharing.
- Agent Project and attached Project precedence.
- Conflict detection for duplicate keys across attached Projects.
- CLI-only plaintext resolve boundary.
- Local folder links for `clawdi run`.

Those semantics are the product moat and should remain Clawdi-native.

## What Commercial Tools Actually Provide

### 1Password

Relevant product patterns:

- Secret reference syntax: `op://vault-name/item-name/[section-name/]field-name`.
- `op read` resolves one secret reference.
- `op run --env-file=.env -- <command>` scans env files and environment
  variables for secret references, then injects plaintext into the child
  process only for its lifetime.
- `op inject` replaces secret references in files.
- Secrets printed to stdout/stderr are masked by default.
- Service accounts can be scoped to vaults and permissions, and can expire.
- CLI caching improves performance while keeping cached data encrypted.

Implication for Clawdi:

- The core UX to copy is secret references plus runtime resolution, not the
  whole 1Password object model.
- Masking, env-file scanning, and explicit service/machine access are table
  stakes for a polished developer experience.

### Bitwarden Secrets Manager

Relevant product patterns:

- Machine account access tokens limit which projects/secrets the CLI can use.
- `bws run --project-id ... -- <command>` injects secrets from a scoped project.
- It supports not inheriting most environment variables.
- It warns that env injection is not a sandbox and untrusted commands can read
  secrets.
- Bitwarden's broader product positioning is end-to-end, zero-knowledge
  encryption.

Implication for Clawdi:

- Project-scoped runtime injection matches Clawdi's Project model well.
- We should document and implement env injection as a convenience mechanism,
  not as isolation.
- The trust model users expect from a password manager is client-side
  encryption, not only server-side KMS.

### Doppler and Infisical

Relevant product patterns:

- `run` commands are ergonomic and broadly compatible because they inject env
  vars into any child process.
- Infisical adds path, environment, tag, import, machine identity, and watch
  behavior.
- Infisical also has secret scanning and newer agent-specific products.

Implication for Clawdi:

- Their developer workflow is worth learning from.
- They are closer to secrets-management products than password-manager trust
  models.
- Infisical is now a direct agent-credential competitor, so it should be
  treated as product research, not a core dependency.

### Keeper Secrets Manager

Relevant product patterns:

- Machine-oriented secrets CLI.
- Native keychain storage for local profiles.
- Environment variable substitution and command execution.

Implication for Clawdi:

- Local credentials and vault unlock material should use OS-native secure
  storage where possible.

### OpenBao

OpenBao Transit provides:

- Encryption as a service.
- Decryption by API call.
- Key versioning and rotation.
- Rewrap without returning plaintext to the caller.
- ACL policies that restrict tokens to paths such as
  `transit/encrypt/<key>`, `transit/decrypt/<key>`, and
  `transit/rewrap/<key>`.
- Audit devices for request/response logging.

OpenBao does not provide:

- Clawdi Project semantics.
- Agent Project and attachment precedence.
- `clawdi://` secret references.
- End-to-end encryption by default.
- A guarantee that Clawdi cannot decrypt if Clawdi holds a decrypt token.

Implication for Clawdi:

- OpenBao is useful for key operations and server-side hardening.
- OpenBao is not a replacement for the Clawdi Vault product surface.
- OpenBao alone does not make the product zero-knowledge.

## Product Goals

1. Give users a commercial password-manager workflow inside Clawdi.
2. Make `clawdi://` a real secret-reference scheme, not just an input parser.
3. Let users keep secret references in `.env`, config files, scripts, agent
   setup, and docs without plaintext leakage.
4. Make CLI and web surfaces feel like one Vault product, not separate tools.
5. Preserve Clawdi Project and Agent semantics.
6. Reduce blast radius for AI agents through scoped grants, TTL, audit, and
   optional proxy/TEE modes.
7. Move toward a trust model where Clawdi cannot decrypt ordinary user vault
   items.
8. Keep OpenBao/KMS behind an adapter so deployment choices do not leak into
   product semantics.

## Non-goals

1. Do not use OpenBao KV as the primary Clawdi vault storage layer.
2. Do not replace Clawdi Vault with Infisical, Bitwarden, or 1Password.
3. Do not claim zero-knowledge while server-side decrypt remains the default.
4. Do not make env injection the final secure-agent model. Env injection is a
   developer convenience, not a sandbox.
5. Do not remove existing Project and Agent conflict behavior.

## Recommended User Experience

### Secret References

Short-term, keep existing project-relative syntax:

```text
clawdi://<vault>/<field>
clawdi://<vault>/<section>/<field>
```

Examples:

```text
clawdi://default/openai/api_key
clawdi://prod/database/url
clawdi://prod/stripe/secret_key
```

Project selection comes from runtime context:

1. Explicit `--project`.
2. Explicit `--agent`.
3. Local Project folder link.
4. Existing default-write Project behavior.

Later, add stable absolute references:

```text
clawdi://project/<project-slug>/vault/<vault>/section/<section>/field/<field>
clawdi://vlt_<id>/item_<id>/field_<id>
```

The web UI should have "Copy Clawdi Reference" on every field.

### CLI Commands

Add 1Password-like general commands:

```bash
clawdi read clawdi://prod/stripe/secret_key

clawdi run --env-file .env -- npm run dev

clawdi inject --in .env.template --out .env.local

clawdi inject --in config.template.json
```

Support `.env` files like:

```env
STRIPE_SECRET_KEY=clawdi://prod/stripe/secret_key
OPENAI_API_KEY=clawdi://default/openai/api_key
```

Change `clawdi run` defaults:

- Default: resolve only explicit `clawdi://` references in inherited env vars
  and `--env-file` files.
- Legacy/all mode: keep existing "inject everything in this Project" behavior
  behind an explicit flag:

```bash
clawdi run --all-vault-env -- npm run dev
```

Add quality-of-life flags:

```bash
clawdi run --env-file .env --no-inherit-env -- npm run dev
clawdi run --agent codex --env-file .env -- npm run test
clawdi read clawdi://prod/db/url --json
clawdi inject --in .env.template --out -    # stdout
```

Default output should mask resolved secrets when possible. A `--no-masking`
escape hatch can exist, but the command should make the risk clear.

### Web Product

The web Vault should support:

- Create vault/item/section/field.
- Copy secret reference.
- Reveal/copy plaintext only after explicit user action.
- Project-level sharing view.
- Agent access view: which Agents can use which Projects.
- Version history and restore.
- Audit timeline.
- Rotate marker and "needs rotation" state.
- Kill switch for a Project, Agent, or individual field.

### Machine and Agent Access

Add Clawdi-native machine credentials similar to service accounts:

```bash
clawdi service-token create ci-prod \
  --project prod:read \
  --expires-in 24h

clawdi agent token create codex-runtime \
  --agent codex \
  --project engineering:read \
  --ttl 1h
```

The product vocabulary should stay Clawdi-native:

- Human users.
- Projects.
- Agents.
- Agent Project.
- Attached Projects.
- Service tokens or runtime tokens.

Avoid borrowing "vault permissions" language where it conflicts with Project
as the data boundary.

## Recommended Architecture

### Module 1: Secret Reference

Deep Module responsible for:

- Parsing `clawdi://`.
- Scanning env vars, dotenv files, and generic templates.
- Variable expansion inside references.
- Batching resolves.
- Reporting missing references.
- Preserving Project/Agent provenance.
- Masking output.
- Conflict diagnostics.

This module should be shared by `read`, `run`, `inject`, and future web helper
surfaces.

### Module 2: Client Vault Crypto

Deep Module responsible for client-side encryption and decryption:

- Per-Project or per-Vault encryption keys.
- Field encryption using AEAD with associated data.
- Local key storage using OS keychain where available.
- Browser unlock via WebCrypto.
- Device enrollment and revocation.
- Key wrapping for users, devices, service tokens, and agents.

Recommended direction:

- Use a VaultKey per Project or per Vault.
- Encrypt each field locally with that VaultKey.
- Store encrypted item ciphertext and metadata on the server.
- Store wrapped VaultKeys for authorized devices/users/agents.
- Treat plaintext secret values as client/runtime memory only.

Associated data should bind ciphertext to stable metadata, for example:

```text
project_id
vault_id
item_id
field_id
version
```

This prevents ciphertext swapping between rows from silently decrypting.

### Module 3: Grant and Capability

Deep Module responsible for "who may unwrap or use what":

- Project membership grants.
- Agent Project and attached Project grants.
- Service/runtime token grants.
- TTL and max TTL.
- Revocation.
- Kill switch.
- Read/write/admin capability separation.
- Audit event emission.

This module is where Clawdi's agent-specific differentiation belongs.

### Module 4: Runtime Secret Delivery

Deep Module responsible for delivering secrets to processes and agents:

1. **Local dev env injection**
   - CLI decrypts locally.
   - Child process receives plaintext env vars.
   - Good for compatibility.
   - Not a sandbox.

2. **Hosted agent basic mode**
   - Runtime receives short-lived plaintext via env or process memory.
   - Scope is Agent + Project + reference list.
   - Strong audit and kill switch required.

3. **Hosted agent secure mode**
   - Agent does not receive long-lived secrets.
   - Requests go through a credential proxy or tool proxy.
   - Proxy attaches credentials to outbound calls.
   - Add policy, rate limits, request audit, and host allowlists.

4. **TEE-backed mode**
   - Decryption or proxy runs inside an attested confidential VM.
   - Useful for stronger "operator cannot inspect runtime memory" claims.
   - Requires separate Phala/dstack or confidential compute evaluation.

### Module 5: Key Operations Adapter

Adapter interface for server-side key operations:

- Local AES-GCM for dev and tests.
- OpenBao Transit for self-hosted/open-source deployments.
- AWS/GCP/Azure KMS for managed deployments.

This adapter should cover:

- Legacy server-side encryption while migrating.
- Rewrap jobs.
- Server-side service-token secrets.
- Auditable decrypt for data that is explicitly server-managed.
- Emergency recovery workflows where the product makes that tradeoff clear.

Do not route ordinary E2EE user-vault decrypt through this adapter once
client-side vault encryption is available.

## Data Model Direction

Keep existing `vaults` and `vault_items` as compatibility surfaces, but move
toward versioned encrypted items.

Candidate tables:

1. `vault_item_versions`
   - `id`
   - `vault_item_id`
   - `version`
   - `ciphertext`
   - `crypto_scheme`
   - `key_ref`
   - `associated_data_hash`
   - `created_by_user_id`
   - `created_at`
   - `replaced_at`
2. `vault_keys`
   - `id`
   - `project_id`
   - `vault_id`
   - `key_version`
   - `status`
   - `created_at`
3. `vault_key_grants`
   - `id`
   - `vault_key_id`
   - `grantee_type` (`user`, `device`, `agent`, `service_token`)
   - `grantee_id`
   - `wrapped_key`
   - `capabilities`
   - `expires_at`
   - `revoked_at`
4. `vault_devices`
   - `id`
   - `user_id`
   - `public_key`
   - `name`
   - `last_seen_at`
   - `revoked_at`
5. `vault_audit_events`
   - `id`
   - `project_id`
   - `vault_id`
   - `item_id`
   - `field_id`
   - `actor_type`
   - `actor_id`
   - `action`
   - `runtime_context`
   - `created_at`
6. `vault_runtime_leases`
   - `id`
   - `project_id`
   - `agent_id`
   - `service_token_id`
   - `scope`
   - `expires_at`
   - `revoked_at`
   - `last_used_at`

## API Direction

Short-term server-managed reference resolution:

```text
POST /api/vault/references/resolve
```

Request:

```json
{
  "references": [
    "clawdi://prod/database/url",
    "clawdi://default/openai/api_key"
  ],
  "project_id": "...",
  "agent_id": "...",
  "allow_conflicts": false
}
```

Response:

```json
{
  "values": {
    "clawdi://prod/database/url": "postgres://...",
    "clawdi://default/openai/api_key": "sk-..."
  },
  "provenance": {},
  "conflicts": []
}
```

Client-side encrypted future:

- Server resolves references to encrypted field blobs and wrapped keys.
- CLI/browser unwraps keys locally and decrypts fields.
- Hosted agent mode requests runtime leases or proxy access instead of raw
  decrypt where possible.

## Security Model Options

### Option A: Current Server-Side Encryption

Properties:

- Easy to operate.
- Backend can decrypt.
- Good enough for early private beta.
- Not password-manager-grade trust.

Use only as the current baseline.

### Option B: OpenBao/KMS Server-Side Key Management

Properties:

- Master key no longer lives as a raw app env var.
- Rotation, rewrap, audit, and token revocation improve substantially.
- Backend can still decrypt if it has a decrypt token.
- Does not satisfy zero-knowledge.

Use for operational hardening and migration, not as the final password-manager
trust model.

### Option C: Client-Side Encrypted Vault

Properties:

- Server stores ciphertext and wrapped keys.
- CLI/browser decrypts locally.
- Clawdi cannot decrypt ordinary user vault values.
- Recovery, sharing, device enrollment, and web unlock become product work.

This is the recommended target for the core password-manager promise.

### Option D: Credential Proxy for Agents

Properties:

- Agent calls APIs through a proxy.
- Proxy attaches credentials.
- Agent never sees long-lived API keys.
- Works across SDKs/CLIs only when traffic can be forced through the proxy.
- Requires network control for strong enforcement.

This is the recommended secure-agent direction.

### Option E: TEE Runtime

Properties:

- Decrypt/proxy logic runs inside an attested confidential VM.
- Helps with "operator cannot inspect runtime memory" claims.
- Does not automatically prevent business logic from returning plaintext if
  the API permits it.
- Operationally more complex.

Treat as a separate feasibility track for hosted agents or high-trust tiers.

## Recommended Phasing

### Phase 1: Secret Reference UX

Goal: make Clawdi feel like a commercial CLI secrets tool without changing
the storage trust model yet.

Deliver:

- `clawdi read clawdi://...`
- `clawdi run --env-file ... -- <cmd>`
- `clawdi inject --in ... --out ...`
- Reference scanner shared across commands.
- Default masking.
- Batch reference resolve endpoint.
- Explicit `--all-vault-env` for legacy all-env injection.
- Web "Copy Clawdi Reference".

Security statement:

- "Clawdi avoids plaintext secrets in local files and injects them only at
  runtime."
- Do not claim Clawdi cannot decrypt.

### Phase 2: Key Operations Hardening

Goal: remove raw `VAULT_ENCRYPTION_KEY` as a production dependency and add
rotation/audit.

Deliver:

- `VaultCryptoEngine` adapter.
- OpenBao Transit adapter or managed KMS adapter.
- Legacy ciphertext dual-read.
- Rewrap migration job.
- Audit for server-side decrypt/rewrap.
- Separate backend, migration, and ops tokens.

Security statement:

- "Production vault encryption keys are managed by KMS/OpenBao with audit and
  rotation."
- Still do not claim zero-knowledge.

### Phase 3: Client-Side Encrypted Vault

Goal: reach password-manager trust for ordinary user vault data.

Deliver:

- Device enrollment.
- Local keychain-backed unlock.
- Browser WebCrypto unlock.
- VaultKey wrapping for users/devices.
- Client-side field encryption.
- Server stores ciphertext only.
- Migration from server-managed to client-managed items.
- Recovery design: recovery key, trusted device recovery, or organization
  recovery policy.

Security statement:

- "For client-managed vaults, Clawdi servers cannot decrypt item values."

### Phase 4: Agent Capability and Lease Model

Goal: make Clawdi Vault differentiated for AI agents.

Deliver:

- Per-Agent secret scopes.
- Runtime leases with TTL/max TTL.
- Kill switch at field, Project, Agent, and service-token levels.
- Per-reference audit.
- Conflict-aware agent runtime resolution.
- Optional approval prompts for sensitive references.

Security statement:

- "Agents get only scoped, auditable, revocable access."

### Phase 5: Secure Hosted Agent Runtime

Goal: reduce or remove plaintext secret exposure to hosted agents.

Deliver:

- Credential proxy mode.
- Host allowlists and request policy.
- Request/response audit controls.
- TEE/dstack proof-of-concept if the product wants verifiable privacy.

Security statement:

- "In secure runtime mode, agents do not receive long-lived credentials."

## Architecture Decision

Recommended decision:

1. Build Clawdi-native secret references and runtime injection first.
2. Add OpenBao/KMS as an operational hardening adapter, not as the product
   storage model.
3. Move core user vaults toward client-side encryption.
4. Treat agent leases, kill switch, and proxy mode as first-class product
   differentiators.
5. Treat Phala/dstack or other TEE deployment as a separate high-trust hosted
   agent feasibility project.

Rejected alternatives:

- **Replace Clawdi Vault with OpenBao KV:** loses Clawdi Project/Agent product
  semantics and does not produce password-manager UX.
- **Use OpenBao Transit as the final trust model:** improves key operations
  but Clawdi can still decrypt with a decrypt token.
- **Depend on Infisical/Bitwarden/1Password:** externalizes a core product
  surface and risks depending on direct competitors or closed services.
- **Keep all-env injection as the main UX:** convenient, but too broad and not
  least-privilege.

## Open Questions

1. What exact security claim do we want for v1 marketing?
   - "No plaintext in files" can ship after Phase 1.
   - "Clawdi cannot decrypt your vault" requires Phase 3.
2. What recovery model is acceptable?
   - Recovery key.
   - Trusted device recovery.
   - Organization admin recovery.
   - No recovery if keys are lost.
3. Should web vault editing be client-side encrypted from day one of Phase 3,
   or CLI-first with web read-only metadata?
4. What is the default hosted-agent mode?
   - Plain env injection with TTL.
   - Proxy-first for supported services.
   - User-selectable trust tier.
5. Are Project-level VaultKeys enough, or do we need per-Vault keys from the
   beginning?
6. Should `clawdi://` references allow variable interpolation like
   `clawdi://$APP_ENV/database/url`?
7. What audit data is safe to show to Project members without leaking secret
   names or sensitive metadata?

## Source Notes

- 1Password CLI supports `read`, `run`, `inject`, `op://` secret references,
  env-file scanning, masking, and service accounts:
  <https://www.1password.dev/cli/reference>
  <https://www.1password.dev/cli/reference/commands/run>
  <https://www.1password.dev/cli/reference/management-commands/service-account>
- Bitwarden Secrets Manager CLI supports machine-account tokens, project
  scoped `run`, env output, and encrypted state files:
  <https://bitwarden.com/help/secrets-manager-cli/>
- Bitwarden's security documentation frames the commercial password-manager
  trust model around end-to-end, zero-knowledge encryption:
  <https://bitwarden.com/help/bitwarden-security-white-paper/>
- Doppler and Infisical show the secrets-manager CLI shape for ergonomic
  env injection:
  <https://docs.doppler.com/docs/cli>
  <https://infisical.com/docs/cli/commands/run>
- Infisical secret scanning is relevant to future Clawdi leak-prevention
  features:
  <https://infisical.com/docs/cli/scanning-overview>
- Keeper Secrets Manager CLI shows machine-oriented profiles, OS-native
  keychain storage, and environment substitution:
  <https://docs.keeper.io/en/keeperpam/secrets-manager/secrets-manager-command-line-interface>
- OpenBao Transit is appropriate for encryption-as-a-service, key rotation,
  rewrap, ACLs, and audit, but not as the Clawdi product model:
  <https://openbao.org/docs/secrets/transit/>
  <https://openbao.org/docs/audit/>
  <https://openbao.org/docs/concepts/policies/>
- dstack/Phala is relevant for future attested hosted-agent runtimes, not as
  the immediate Vault replacement:
  <https://github.com/Dstack-TEE/dstack>
  <https://phala.com/learn/Open-Source-Confidential-Computing-Tools>
