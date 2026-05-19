# Clawdi Vault Password Manager Research

**Status:** research expanded; architecture direction proposed
**Last updated:** 2026-05-19
**Owner:** product + platform

## Summary

Clawdi should not replace its Vault product surface with OpenBao, Infisical,
Bitwarden, or another external secrets product. The product direction should
be a Clawdi-native password-manager experience:

- 1Password-style secret references, `read`, `run`, and `inject`.
- First-class Clawdi Project and Agent semantics around those references.
- Vault maturity features users expect from commercial tools: audit, versions,
  rollback, scoped service tokens, TTL, and kill switches.
- Bitwarden/1Password-style client-side encrypted vault data for user-owned
  secrets.
- Clawdi-specific Project, Agent Project, attachment order, and conflict
  semantics.
- Agent-specific runtime controls: lease/TTL, kill switch, audit, and a
  deferred credential proxy track for hosted agents.
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

Important prioritization update: Agent Vault-style proxying is technically the
right long-term answer for hosted agents, but it should not block the first
Clawdi Vault release. Proxy mode needs controlled networking, CA/proxy
compatibility, request policy, and careful logging boundaries. Phase 1 should
ship password-manager workflow first, while preserving data-model and API
extension points for proxy/runtime policies.

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

### Infisical Agent Vault

Relevant product patterns:

- Agent Vault is an MIT-licensed credential broker and vault for AI agents.
  The open-source license permits commercial use, modification, and
  distribution outside any enterprise-only `ee/` code, provided copyright and
  license notices are preserved.
- Its core idea is not env injection. The agent receives dummy credentials or
  no real credential at all, sends ordinary HTTP(S) requests through a proxy,
  and the broker injects real credentials at the outbound request boundary.
- Service rules map host/path patterns to auth injection behavior. Credentials
  are referenced by key name, not embedded in the service config.
- Agents can be long-lived named identities or receive short-lived,
  vault-scoped sessions from `vault run`.
- Proposal workflows let agents request new services or credentials, then wait
  for a human to approve, reject, or provide the missing credential.
- Strict deny mode, egress filtering, request logging, and per-vault roles are
  central to the model.
- Agent Vault's own docs are explicit that local `vault run` is not a sandbox:
  a child process can bypass proxy environment variables unless the runtime
  also controls network egress.

Implication for Clawdi:

- Agent Vault is the strongest reference for Clawdi's future hosted-agent
  secure runtime.
- The design principle to absorb is: credential use should become a scoped
  outbound capability, not a plaintext string handed to the agent.
- The product mechanisms worth copying are service rules, dummy credential
  substitution, proposal approval, strict unmatched-host deny, scoped sessions,
  token rotation, and request audit.
- Do not directly depend on Agent Vault as Clawdi's core Vault backend. Its
  object model is Infisical's, not Clawdi's Project + Agent Project +
  attachment model, and it primarily covers HTTP(S) API credentials rather than
  all local secret-reference workflows.
- Proxy mode should be planned as a deferred Clawdi Secure Runtime track, not
  as a Phase 1 dependency.

### Keeper Secrets Manager

Relevant product patterns:

- Machine-oriented secrets CLI.
- Native keychain storage for local profiles.
- Environment variable substitution and command execution.

Implication for Clawdi:

- Local credentials and vault unlock material should use OS-native secure
  storage where possible.

### AWS Secrets Manager Agent and HashiCorp Vault Agent

Relevant product patterns:

- AWS Secrets Manager Agent is a local HTTP service that lets workloads fetch
  secrets from `localhost`, caches secret values in memory, is read-only, and
  includes SSRF protection. Its default cache refresh TTL is 300 seconds.
- HashiCorp Vault Agent handles auto-authentication, token and lease renewal,
  client-side caching, template rendering, and process-supervisor mode that can
  inject secrets into a child process environment.
- Both products treat secret delivery as a runtime integration problem, not only
  as a storage problem.

Implication for Clawdi:

- A local/sidecar agent pattern is useful for hosted agents, CI, and long-running
  workloads where repeated CLI resolves are clumsy.
- A localhost credential service must have request signing or loopback-only
  controls, reference/path scoping, SSRF defenses, TTLs, and audit from day one.
- Template rendering and env injection are compatibility paths; proxy or
  capability-mediated access is the safer agent-native direction.

### Akeyless

Relevant product patterns:

- Akeyless markets a SaaS secrets platform around zero-knowledge encryption and
  Distributed Fragments Cryptography.
- The Akeyless Gateway / Universal Secrets Connector pattern keeps a customer
  controlled component close to workloads and identity sources.
- It supports many auth methods and cloud/Kubernetes deployment patterns.

Implication for Clawdi:

- The market has appetite for SaaS secrets products that still provide a
  customer-controlled cryptographic boundary.
- Clawdi can use this as evidence for an eventual customer-held/device-held key
  story while keeping the product surface agent-native.
- A gateway/connector can be a later enterprise deployment mode for teams that
  want local policy enforcement near their infrastructure.

### Agent OAuth and Connected-Account Platforms

Relevant product patterns:

- Composio uses hosted Connect Links so users can connect accounts during chat
  or onboarding.
- The agent platform handles OAuth flows, token refresh, and credential
  management for tool calls.
- This is closer to agent tool authorization than generic password management.

Implication for Clawdi:

- Static API keys are only one class of agent credential. OAuth connected
  accounts, delegated tool execution, and per-tool permissions should be part of
  the long-term Vault model.
- Clawdi Vault should store both secret references and connected-account handles.
- Proxy execution can reduce how often agents receive raw OAuth refresh tokens
  or long-lived API keys.

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

## Agent Credential Threat Model

Clawdi Vault has a broader threat model than a normal developer secrets CLI
because AI agents can read files, call tools, run commands, and transform secret
material into follow-up actions. The core risks are:

1. **Plaintext-at-rest leakage**
   - Secrets copied into `.env`, shell history, config files, issue comments,
     logs, generated code, or agent memory.
   - Response: secret references, `inject`, `run`, masking, scanning, and
     reference-first docs.
2. **Untrusted child process or dependency**
   - Any process launched with env vars can read and exfiltrate them.
   - Response: least-reference resolution, `--no-inherit-env`, TTLs, warnings,
     and clear docs that env injection is a compatibility mechanism.
3. **Hosted-agent prompt/tool exfiltration**
   - An agent can be instructed to print, save, or transmit values it can read.
   - Response: per-Agent grants, approval prompts for sensitive references,
     egress/tool policy, per-reference audit, and kill switches.
4. **Backend/operator compromise**
   - Server-side decrypt authority turns backend compromise into Vault
     compromise.
   - Response: KMS/OpenBao hardening first, then client-side encryption for
     ordinary user-managed vault items.
5. **Database or backup leak**
   - Encrypted blobs and metadata can reveal names, structure, and access
     patterns.
   - Response: AEAD associated data, key separation, metadata minimization,
     item versioning, and audit redaction.
6. **Localhost credential-service abuse**
   - A browser, malicious dependency, or SSRF path can try to hit a local
     credential endpoint.
   - Response: loopback binding plus request tokens, origin/path checks,
     reference allowlists, short leases, and no broad list/read endpoints.
7. **Collaborator and Project-sharing mistakes**
   - A shared Project can expose secrets to the wrong Agent or user.
   - Response: Project membership review, explicit Agent attachment, conflict
     diagnostics, scoped service tokens, and visible access graph.

This threat model pushes Clawdi toward three distinct delivery modes: local dev
env injection for compatibility, local/sidecar service for workload ergonomics,
and proxy/TEE-backed access for hosted agents with stronger controls. The first
two are near-term product work; proxy/TEE belongs behind a separate proof of
concept because it needs runtime network control to make the security claim
honest.

## Product Goals

1. Give users a commercial password-manager workflow inside Clawdi.
2. Make `clawdi://` a real secret-reference scheme, not just an input parser.
3. Let users keep secret references in `.env`, config files, scripts, agent
   setup, and docs without plaintext leakage.
4. Make CLI and web surfaces feel like one Vault product, not separate tools.
5. Preserve Clawdi Project and Agent semantics.
6. Reduce blast radius for AI agents through scoped grants, TTL, audit, and
   explicit future proxy/TEE modes.
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
6. Do not build an HTTPS proxy/MITM system in Phase 1. Keep the architecture
   ready for it, but defer implementation until hosted-agent runtime isolation
   is better understood.

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
   - This is the realistic near-term hosted-agent path.

3. **Local/sidecar service mode**
   - Long-running workloads resolve explicit references from a local service.
   - Requires loopback binding, request tokens, reference allowlists, TTLs, and
     no broad list/read endpoint.
   - Inspired by AWS Secrets Manager Agent and Vault Agent.
   - Useful for CI and daemon-style agents where repeated CLI resolves are
     awkward.

4. **Deferred hosted-agent proxy mode**
   - Agent does not receive long-lived secrets.
   - Requests go through a credential proxy or tool proxy.
   - Proxy attaches credentials to outbound calls.
   - Add policy, rate limits, request audit, and host allowlists.
   - Requires controlled network egress, CA/proxy compatibility work, and
     careful request/response logging policy.
   - Treat as a later proof of concept, not Phase 1 or Phase 2.

5. **TEE-backed mode**
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
   - `credential_kind` (`secret_value`, `connected_account`, `proxy_binding`)
   - `key_ref`
   - `associated_data_hash`
   - `runtime_policy`
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
7. `vault_service_bindings`
   - `id`
   - `project_id`
   - `vault_id`
   - `credential_id`
   - `service_name`
   - `host_pattern`
   - `path_pattern`
   - `auth_strategy`
   - `enabled`
   - `created_at`

The `credential_kind`, `runtime_policy`, and `vault_service_bindings` fields
are future-proofing seams. Phase 1 can store only ordinary secret values, but
the model should not assume every credential is forever delivered as a raw env
string. Later proxy mode can attach a credential to a host/path service binding
without changing the user-facing `clawdi://` reference model.

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
- Hosted agent basic mode requests runtime leases for explicit references.
- Future proxy mode resolves references to service bindings and credential
  capabilities instead of returning raw secret values.

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

This is the recommended secure-agent direction, but it is not recommended for
Phase 1. Treat it as a hosted-agent proof of concept after reference UX and
basic Vault maturity are in place.

### Option E: TEE Runtime

Properties:

- Decrypt/proxy logic runs inside an attested confidential VM.
- Helps with "operator cannot inspect runtime memory" claims.
- Does not automatically prevent business logic from returning plaintext if
  the API permits it.
- Operationally more complex.

Treat as a separate feasibility track for hosted agents or high-trust tiers.

## Phase 1 Build Scope

Phase 1 should be intentionally narrow so the product quickly feels like a
password manager while preserving honest security claims.

Ship first:

1. Reference parser and scanner shared by CLI commands.
2. `clawdi read <clawdi://...>` with JSON and masked-default output modes.
3. `clawdi run --env-file ... -- <cmd>` that resolves only explicit references
   by default.
4. `clawdi inject --in ... --out ...` for template workflows.
5. Batch resolve API with provenance and conflict diagnostics.
6. Web "Copy Clawdi Reference" on every field.
7. Masking for Clawdi-owned output. Child-process stdout/stderr masking should
   be optional or deferred because piping output can break TTY behavior.
8. Product copy that says Clawdi keeps plaintext out of files and injects at
   runtime.
9. Minimal `credential_kind` and `runtime_policy` fields or API placeholders so
   later proxy/service-binding work does not require a reference-model rewrite.

Defer from Phase 1:

1. Zero-knowledge marketing claims.
2. Full client-side encrypted vault migration.
3. OpenBao/KMS production adapter.
4. Hosted-agent proxy enforcement.
5. Dynamic secrets engines and full enterprise gateway deployment.
6. HTTPS proxy/MITM mode and CA injection.
7. Localhost sidecar service.

Acceptance criteria:

1. A developer can replace a plaintext `.env` file with `clawdi://` references.
2. The same references work through `read`, `run`, and `inject`.
3. Duplicate references across attached Projects produce a deterministic conflict
   explanation.
4. CLI output masks resolved secret values in Clawdi-owned logs and messages by
   default.
5. Documentation clearly states env injection is a compatibility mechanism.
6. The model can represent a future non-env credential delivery mode without
   changing `clawdi://` references.

## Recommended Phasing

### Phase 1: Secret Reference UX

Goal: make Clawdi feel like a commercial CLI secrets tool without changing
the storage trust model yet. This phase proves workflow value and replaces
plaintext `.env` habits.

Deliver:

- `clawdi read clawdi://...`
- `clawdi run --env-file ... -- <cmd>`
- `clawdi inject --in ... --out ...`
- Reference scanner shared across commands.
- Default masking.
- Batch reference resolve endpoint.
- Explicit `--all-vault-env` for legacy all-env injection.
- Web "Copy Clawdi Reference".
- Minimal credential metadata for future delivery modes:
  `credential_kind`, `runtime_policy`, and service-binding placeholders.
- Documentation that clearly says env injection is not isolation.

Security statement:

- "Clawdi avoids plaintext secrets in local files and injects them only at
  runtime."
- Do not claim Clawdi cannot decrypt.

### Phase 2: Vault Maturity

Goal: make the server-managed Vault operationally credible before attempting
client-side encryption or proxy mode.

Deliver:

- Vault audit events for create/update/delete/resolve/read-reference/runtime
  lease.
- Item version history and rollback.
- Project/Agent visible access graph.
- Scoped service tokens and runtime tokens.
- TTL/max TTL on runtime access.
- Kill switch at field, vault, Project, Agent, and token levels.
- Resolve and run flows that always carry provenance.
- `VaultCryptoEngine` adapter.
- OpenBao Transit adapter or managed KMS adapter.
- Legacy ciphertext dual-read.
- Rewrap migration job.
- Audit for server-side decrypt/rewrap.
- Separate backend, migration, and ops tokens.
- Design-only sidecar/local service spec with SSRF and loopback protections;
  implementation can wait unless a workload needs it.

Security statement:

- "Production vault encryption keys are managed by KMS/OpenBao with audit and
  rotation."
- "Secret access is scoped, logged, expirable, and revocable."
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

### Phase 4: Hosted-Agent Proxy PoC

Goal: evaluate Agent Vault-style credential brokering only where Clawdi controls
the runtime enough to enforce it.

Deliver:

- One or two supported services first, such as Anthropic and GitHub.
- Service binding model: host/path -> credential injection policy.
- Dummy credential substitution.
- Strict deny for unmatched hosts by default in controlled sandboxes.
- Scoped proxy sessions minted by Clawdi runtime.
- CA/proxy bootstrap for the supported hosted runtime only.
- Request/response audit controls.
- Human approval flow for new service access.
- Explicit bypass analysis: what network paths can avoid the proxy?
- TEE/dstack proof-of-concept only if product wants verifiable runtime privacy.

Security statement:

- "In controlled hosted runtime proxy mode, agents do not receive long-lived
  credentials for supported HTTP(S) services."
- Do not promise this for local `clawdi run` or unmanaged machines.

## Architecture Decision

Recommended decision:

1. Build Clawdi-native secret references and runtime injection first.
2. Mature the server-managed Vault with audit, versions, rollback, scoped
   tokens, TTL, kill switches, and OpenBao/KMS key operations.
3. Move core user vaults toward client-side encryption once the product
   workflow is proven.
4. Keep Agent Vault-style proxying as a first-class architecture slot, but defer
   implementation to a hosted-agent proof of concept where Clawdi can control
   egress and CA/proxy bootstrapping.
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
- **Build proxy mode before reference UX:** technically attractive, but it
  introduces CA, MITM, egress-control, compatibility, and logging risks before
  users have the basic password-manager workflow.

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
   - Lease-scoped plaintext injection first.
   - Proxy-first only for controlled hosted sandboxes after a PoC.
   - User-selectable trust tier.
5. Are Project-level VaultKeys enough, or do we need per-Vault keys from the
   beginning?
6. Should `clawdi://` references allow variable interpolation like
   `clawdi://$APP_ENV/database/url`?
7. What audit data is safe to show to Project members without leaking secret
   names or sensitive metadata?
8. Which runtime does the first proxy PoC target?
   - Clawdi-hosted containers.
   - E2B/Daytona/Firecracker-style sandboxes.
   - A single supported local agent with clear "not a sandbox" warnings.
9. Which services are worth supporting first for proxy mode?
   - Anthropic and GitHub are the obvious candidates because they are central
     to coding agents and have straightforward HTTP APIs.

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
- Infisical Agent Vault is the main reference for hosted-agent credential
  brokering: MIT-licensed proxy/vault, dummy credential substitution, service
  rules, proposals, scoped sessions, and explicit "not a sandbox" caveats:
  <https://github.com/Infisical/agent-vault>
  <https://docs.agent-vault.dev/>
  <https://docs.agent-vault.dev/learn/security>
  <https://docs.agent-vault.dev/learn/services>
  <https://docs.agent-vault.dev/learn/proposals>
  <https://docs.agent-vault.dev/agents/overview>
- Keeper Secrets Manager CLI shows machine-oriented profiles, OS-native
  keychain storage, and environment substitution:
  <https://docs.keeper.io/en/keeperpam/secrets-manager/secrets-manager-command-line-interface>
- AWS Secrets Manager Agent and HashiCorp Vault Agent show local/sidecar
  delivery patterns: localhost HTTP cache, read-only secret access, auto-auth,
  lease renewal, templating, and process-supervisor injection:
  <https://docs.aws.amazon.com/secretsmanager/latest/userguide/secrets-manager-agent.html>
  <https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent>
  <https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent/template>
- Akeyless is relevant as a SaaS secrets-manager proof point for
  customer-controlled cryptographic boundaries and gateway deployment patterns:
  <https://docs.akeyless.io/docs/universal-secrets-connector>
- Composio is relevant for agent OAuth / connected-account UX, where the agent
  platform manages Connect Links, OAuth, token refresh, and credential handling
  for tool calls:
  <https://docs.composio.dev/docs/authentication>
- OpenBao Transit is appropriate for encryption-as-a-service, key rotation,
  rewrap, ACLs, and audit, but not as the Clawdi product model:
  <https://openbao.org/docs/secrets/transit/>
  <https://openbao.org/docs/audit/>
  <https://openbao.org/docs/concepts/policies/>
- dstack/Phala is relevant for future attested hosted-agent runtimes, not as
  the immediate Vault replacement:
  <https://github.com/Dstack-TEE/dstack>
  <https://phala.com/learn/Open-Source-Confidential-Computing-Tools>
