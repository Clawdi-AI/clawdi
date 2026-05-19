# Clawdi Vault Password Manager Research

**Status:** reviewed; Phase 1 implementation target
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

Current implementation target:

1. Ship the Phase 1 reference workflow: `clawdi://`, `read`, `run --env-file`,
   `inject`, masking, provenance, and conflict handling.
2. Keep P0 credential-profile support narrow and allowlisted: Codex, Claude
   Code, and GitHub CLI.
3. Treat macOS Keychain and other OS credential stores as explicit interactive
   sources. A user-approved system prompt is acceptable on macOS, but silent
   scraping is not. Headless/CI flows must use file, token, helper, or
   environment-based paths instead.
4. Preserve honest custody copy: server-managed credentials can be decrypted by
   Clawdi today; client-managed credentials are the future trust target.

Important prioritization update: Agent Vault-style proxying is technically the
right long-term answer for hosted agents, but it should not block the first
Clawdi Vault release. Proxy mode needs controlled networking, CA/proxy
compatibility, request policy, and careful logging boundaries. Phase 1 should
ship password-manager workflow first, while preserving data-model and API
extension points for proxy/runtime policies.

Second-pass research update: the agent-credential market is not one category.
It splits into four separate problems:

1. **Secret reference UX** — 1Password, Doppler, Infisical CLI, Bitwarden
   Secrets Manager, and similar tools help users avoid plaintext config files
   by resolving secrets at runtime.
2. **Credential broker/proxy** — Infisical Agent Vault, Authsome, Secretless
   Broker, and Boundary credential injection keep credentials out of the
   caller process by injecting them at a controlled boundary.
3. **Tool/OAuth authorization** — Arcade, Composio, Cred, Grantex, Better Auth
   Agent Auth, and the MCP Authorization spec focus on delegated user consent,
   connected accounts, scopes, tool grants, and audit.
4. **Workload identity** — Teleport Machine & Workload Identity, SPIFFE-style
   systems, and cloud OIDC federation reduce the need for stored static
   secrets by issuing short-lived workload credentials.

Clawdi Vault must treat those as different credential delivery modes behind one
Project/Agent product model. The product should not force every future
credential into "a string returned as an env var."

Decision impact from the second pass:

- The Phase 1 recommendation does **not** change: ship `clawdi://`, `read`,
  `run --env-file`, `inject`, masking, provenance, and conflict handling first.
- The medium-term product target **does** broaden: Vault should become a
  credential-and-capability layer, not only a secret-string store.
- The data model must reserve room for `secret_value`, `oauth_connection`,
  `local_agent_profile`, `service_binding`, `proxy_binding`,
  `workload_identity`, and `delegated_tool_grant`.
- The product must label credential custody explicitly. Client-managed vault
  items, server-managed connected accounts, TEE-managed proxy sessions, and
  external workload identities have different security claims.
- Agent Vault-style proxying is still the right hosted-agent security track,
  but it remains a later proof of concept because its guarantee depends on
  controlled egress and proxy enforcement.

## Product Definition

Clawdi Vault is an agent-native credential layer. It is not a general-purpose
password manager, not a full Infisical replacement, and not a low-level key
management system.

The product job is:

> Let a person or team give an AI agent the credentials it needs for a specific
> Project and runtime task, without copying plaintext secrets into files,
> prompts, logs, or broad process environments, and with enough provenance,
> audit, expiry, and revocation to recover when the agent or workflow changes.

The narrow v1 promise is:

> Clawdi keeps plaintext credentials out of repo files and local config by
> turning them into `clawdi://` references that resolve only at runtime through
> Project-aware, conflict-aware CLI and web workflows.

The later trust promise is:

> For client-managed vaults, Clawdi servers store ciphertext and grants but
> cannot decrypt item values.

That promise applies only to credentials whose `custody_model` is
client-managed. Some future credential types may intentionally be
server-managed because Clawdi needs to refresh an OAuth token, mint a runtime
session, or attach a credential inside a hosted tool/proxy gateway. Those modes
can reduce what the agent sees, but they do not mean Clawdi is unable to use the
credential.

The later agent-runtime promise is:

> For controlled hosted runtimes, Clawdi can convert selected credentials from
> plaintext strings into scoped outbound capabilities, so agents use APIs
> without receiving long-lived credential values.

## Target Users

1. **Solo developer using local agents**
   - Wants one place to store API keys and DB URLs used by Claude Code, Codex,
     Hermes, OpenClaw, scripts, and local dev servers.
   - Cares about not committing `.env` files and not manually copying keys
     between machines.
   - Also wants Clawdi to back up and re-materialize local CLI credentials,
     such as Codex, Claude Code, and GitHub CLI auth files, without copying
     tokens by hand.
2. **Small team sharing Projects**
   - Wants shared Project credentials with clear ownership, conflict handling,
     and visible access.
   - Cares about revoking a member or Agent without rotating everything by
     hand.
3. **Operator running hosted or remote agents**
   - Wants agents to use GitHub, Anthropic, Stripe, or internal APIs without
     exposing broad long-lived tokens to the agent process.
   - Cares about audit, TTL, kill switch, and eventually proxy-mode isolation.
4. **Security-conscious buyer**
   - Wants a credible path from server-managed encryption to client-managed
     encryption and customer-controlled boundaries.
   - Cares about honest claims more than premature zero-knowledge marketing.

## Product Principles

1. **References first, plaintext last**
   - The durable artifact users write into files, docs, scripts, and agent
     setup should be a `clawdi://` reference, not a secret value.
2. **Project is the human boundary; Agent is the runtime boundary**
   - Sharing answers who may access a Project.
   - Agent Project and attachments answer which Projects a runtime may use.
3. **Runtime delivery is explicit**
   - `read`, `run`, `inject`, hosted runtime leases, and future proxy mode are
     different delivery choices with different risk levels.
4. **Every resolved secret has provenance**
   - Users must be able to see which Project, vault, section, field, and Agent
     context produced a value.
5. **Do not overclaim**
   - Server-managed encryption is not zero-knowledge.
   - Env injection is not a sandbox.
   - Proxy mode is only strong when network egress is controlled.
6. **Leave room for capabilities**
   - Even when Phase 1 returns strings, the model should support future
     credential kinds: raw secret value, local agent profile, OAuth
     connection, delegated tool grant, workload identity, service binding, and
     proxy capability.
7. **Prefer replacing static secrets where possible**
   - Some credentials should never become vault strings at all. OAuth,
     workload identity, GitHub App installation tokens, cloud OIDC federation,
     and short-lived certificates are often better primitives than long-lived
     API keys.
8. **Name the custody model**
   - "Clawdi cannot decrypt" is valid only for client-managed vault items.
     Server-managed connected accounts, proxy bindings, and hosted runtime
     credentials require different claims: scoped, audited, expirable, and
     revocable.

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

- Agent Vault's open-source repo is an MIT-licensed credential broker and vault
  for AI agents. The license permits commercial use, modification, and
  distribution for the open-source code outside any enterprise-only `ee/` code,
  provided copyright and license notices are preserved.
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

### Emerging Agent-Native Vaults and Local Brokers

Relevant product patterns:

- Authsome is a local-first, MIT-licensed credential broker. It stores
  credentials in an encrypted local SQLite vault, handles OAuth refresh, and
  injects credentials through a local HTTP proxy. Its positioning is explicitly
  local, single-user, and no-cloud.
- Cred focuses on OAuth credential delegation for agents. Refresh tokens stay
  in a broker-side vault; agents receive short-lived access tokens and signed
  delegation receipts.
- PassBox presents the combined shape many teams will expect: zero-knowledge
  E2E encryption, CLI-native `get/set/run`, `.env` workflows, and an MCP server
  for agents.

Implication for Clawdi:

- The emerging market validates our product framing: users want
  password-manager workflow plus agent credential control.
- Authsome reinforces that local proxy mode can be useful, but it is a
  different product from Clawdi's cloud Project/Agent sharing model.
- Cred reinforces that OAuth connected accounts should be first-class objects,
  not merely plaintext refresh tokens stored as generic secret fields.
- PassBox reinforces the eventual client-side encrypted vault expectation.
  Clawdi can defer that trust model, but should not make data-model choices that
  block it.

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

### Secretless Broker, Boundary, and Workload Identity

Relevant product patterns:

- CyberArk Secretless Broker lets applications connect to databases and other
  services without fetching or managing secrets. The broker authenticates to
  the target on behalf of the application.
- HashiCorp Boundary distinguishes credential brokering from credential
  injection. Brokering returns the credential to the user/session; injection
  passes the credential to a worker that authenticates to the target on the
  user's behalf, so the user never sees it.
- Teleport Machine & Workload Identity replaces long-lived secrets with
  short-lived certificates and JWTs for non-human identities, issued and renewed
  by a workload agent.

Implication for Clawdi:

- "Return a secret value" and "use a credential on behalf of the caller" are
  different product modes. Clawdi should name them separately.
- Credential injection is stronger than brokering when Clawdi controls the
  worker or hosted runtime. For local unmanaged processes, it is mostly a
  convenience layer unless network egress is controlled.
- Workload identity is the best answer whenever an upstream supports it. Clawdi
  Vault should eventually prefer short-lived identity federation over storing
  static cloud keys.

### Agent OAuth and Connected-Account Platforms

Relevant product patterns:

- Composio uses hosted Connect Links so users can connect accounts during chat
  or onboarding.
- The agent platform handles OAuth flows, token refresh, and credential
  management for tool calls.
- This is closer to agent tool authorization than generic password management.
- Arcade handles OAuth 2.0, API keys, and user tokens needed by agents to call
  external services through tools, and prompts users when a tool needs
  authorization.
- MCP Authorization is converging around OAuth 2.1, Protected Resource Metadata,
  authorization-server discovery, and optional dynamic client registration.
- Better Auth Agent Auth and Grantex represent a newer layer: agents discover
  capabilities, request grants, receive short-lived JWTs, and call tools under
  explicit scopes.

Implication for Clawdi:

- Static API keys are only one class of agent credential. OAuth connected
  accounts, delegated tool execution, and per-tool permissions should be part of
  the long-term Vault model.
- Clawdi Vault should store both secret references and connected-account handles.
- Proxy execution can reduce how often agents receive raw OAuth refresh tokens
  or long-lived API keys.
- A future Clawdi "Vault" item may be a connected account or tool grant, not a
  decryptable string field. The UI and API should not overfit to "secret value"
  as the only credential representation.
- MCP/tool authorization should be designed alongside Vault, because agents will
  increasingly ask for tool capabilities rather than raw credentials.

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

This threat model pushes Clawdi toward several distinct delivery modes: local
dev env injection for compatibility, lease-scoped hosted-agent plaintext for
the near-term hosted path, local/sidecar service for workload ergonomics,
authorization/tool grants for SaaS tools, and proxy/TEE-backed access for
hosted agents with stronger controls. Reference UX and scoped runtime leases
are near-term product work. Proxy/TEE belongs behind a separate proof of
concept because it needs runtime network control to make the security claim
honest.

Second-pass research adds a fourth direction: **authorization instead of
secret delivery**. For SaaS tools and MCP servers, the safer primitive is often
"this agent may perform this scoped action for this human" rather than "this
agent may read this API token." Clawdi Vault should therefore evolve into a
credential-and-capability layer, not only a secret-string store.

## Product Goals

1. **Replace plaintext secret habits with references**
   - A user should be able to turn a plaintext `.env` or config template into
     durable `clawdi://` references and keep working locally.
2. **Make secret resolution Project-aware and Agent-aware**
   - The same reference should resolve through explicit Project selection,
     folder links, or Agent Project attachment order without losing provenance.
3. **Make conflicts safer than silent precedence**
   - Duplicate keys across attached Projects should block by default and
     explain the winning and conflicting sources.
4. **Make Vault usable from both CLI and web**
   - Users should create, inspect, copy references, and understand access from
     the dashboard, while the CLI handles runtime delivery.
5. **Add operational controls before stronger crypto claims**
   - Audit, versions, rollback, scoped tokens, TTL, and kill switches should
     land before client-side encryption or proxy mode.
6. **Move toward a client-managed trust model**
   - For ordinary user vault items, the target state is server-stored
     ciphertext with client-held or client-unwrapped keys.
7. **Reserve proxy/TEE for controlled hosted runtimes**
   - Agent Vault-style proxying remains a strategic track, but only where
     Clawdi can enforce network/proxy behavior.
8. **Keep key-management infrastructure behind adapters**
   - OpenBao/KMS should improve server-side key operations without becoming
     the product model or leaking deployment choices into user workflows.
9. **Treat connected accounts and grants as first-class credentials**
   - OAuth refresh tokens, user consent, tool scopes, and delegated grants
     should not be hidden as generic plaintext fields forever. They need their
     own lifecycle, revocation, audit, and user approval surfaces.
10. **Separate user secrecy from agent least privilege**
   - Client-side encryption protects users from Clawdi decrypting ordinary
     vault values.
   - Tool authorization and proxying protect users from agents seeing broad
     credentials.
   - They are complementary but not the same security property.
11. **Make local CLI credentials portable without copying tokens by hand**
   - Users should be able to explicitly import and materialize allowlisted CLI
     credential profiles, starting with Codex, Claude Code, and GitHub CLI.
   - This is a backup/restore and controlled-sharing workflow, not a promise
     that Clawdi can silently extract every OS credential-store secret.

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
7. Do not build broad enterprise secrets-manager features before the agent
   workflow is proven: dynamic DB credentials, PKI, SSH certificates,
   Kubernetes operators, cross-cloud syncs, and full policy engines are later
   integrations or enterprise tracks.
8. Do not silently scrape macOS Keychain, Windows Credential Manager, Linux
   Secret Service, browser password stores, SSH agents, or provider-specific
   token helpers. Any future credential-store bridge must be explicit,
   interactive, audited, and adapter-specific.
9. Do not treat a successful local credential import as proof that the same
   credential can be safely shared with a team or hosted agent. Sharing and
   hosted materialization require separate confirmation, audit, and custody
   labels.

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

### Phase 1 User Journey

The first release should make one workflow feel complete:

1. User stores a secret through CLI or web.
2. User copies or types a `clawdi://` reference.
3. User replaces plaintext values in `.env`, config templates, or scripts with
   that reference.
4. User runs `clawdi run --env-file .env -- <cmd>` or
   `clawdi inject --in config.template --out config`.
5. Clawdi resolves only the explicit references, shows which Project context was
   used, and refuses ambiguous Agent-attached Project conflicts by default.
6. The child process or generated file receives the plaintext value; Clawdi's
   own logs and diagnostics do not print it.

This journey is successful even before client-side encryption ships because it
removes plaintext from durable files and validates the agent-native reference
model.

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

For Phase 1, the web surface should stay narrow:

- Create and edit vault metadata and fields using the existing server-managed
  encryption model.
- Show field names and sections without exposing values by default.
- Reveal/copy plaintext only after explicit user action and only for authorized
  users.
- Copy `clawdi://` reference for each field.
- Show Project and Agent access context enough to explain where runtime
  resolution will read from.

Avoid building a heavy generic password-manager UI before references and
runtime delivery are proven.

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

### Local Agent Credential Profiles

Clawdi should also manage local credential profiles for developer and agent
CLIs. P0 is Codex, Claude Code, and GitHub CLI because these are the first
credentials users need when moving between machines or hosted agent
environments.

Target workflow:

```bash
clawdi agent credentials import codex \
  --project personal \
  --from ~/.codex/auth.json

clawdi agent credentials import claude-code \
  --project personal \
  --from ~/.claude/.credentials.json

clawdi agent credentials import claude-code \
  --project personal \
  --source keychain

clawdi agent credentials import gh \
  --project personal \
  --from ~/.config/gh/hosts.yml

clawdi agent credentials materialize codex \
  --project personal \
  --to ~/.codex/auth.json
```

This is different from `clawdi run --env-file`:

- `run` injects secrets into one child process.
- Local agent credential profiles restore a tool's expected credential file so
  the tool can run normally.

Design constraints:

- Use per-tool adapters, not broad home-directory scanning.
- Treat OS credential stores as guarded sources, not files. They can sometimes
  be read by the owning app, a signed app in the same access group, a user-
  approved process, or a tool's own export command, but that is platform- and
  tool-specific. P0 file adapters do not call `security`, Windows Credential
  Manager, Secret Service, or `gh auth token` by default.
- A macOS Keychain adapter is acceptable when it is user-initiated and
  interactive. The command must say exactly which tool credential it will read,
  warn that macOS may show a system authorization prompt, and never run in
  non-interactive mode unless the source is explicitly selected.
- P0 built-in adapter paths:
  - Codex: `$CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json`.
  - Claude Code: `$CLAUDE_CONFIG_DIR/.credentials.json`, defaulting to
    `~/.claude/.credentials.json` on Linux/Windows. macOS stores Claude Code
    credentials in Keychain, so file import is best-effort there. A
    `--source keychain` adapter can be implemented once the current Claude Code
    Keychain service/account contract is verified.
  - GitHub CLI: `$GH_CONFIG_DIR/hosts.yml`, defaulting to the same config
    precedence as `gh` (`$XDG_CONFIG_HOME/gh`, Windows `%AppData%/GitHub CLI`,
    then `~/.config/gh`). If `gh` stores the token only in the system credential
    store, a future explicit `--source gh-auth-token` adapter may call
    `gh auth token` and materialize through `gh auth login --with-token`, but
    only after user confirmation.
- Never import logs, history, shell snapshots, session archives, MCP configs, or
  other runtime artifacts.
- Always show a dry-run summary of paths and file sizes before import.
- Materialization should write atomically, preserve file permissions, and create
  a timestamped backup by default.
- Materializing back into an OS credential store is a separate adapter path.
  It must use the tool's documented login/import command or a verified
  Keychain/Credential Manager item contract; never write arbitrary credential
  store rows based on guesses.
- The default storage target should be `custody_model=client_managed` once
  client-side encryption exists. Until then, product copy must say Clawdi can
  decrypt server-managed imported credentials.
- For team sharing, require explicit confirmation before a local agent profile
  can be granted to another user, Agent, Project, or service token.

Implemented Phase 1 boundary:

- `clawdi agent credentials import` uses a two-step preview/read flow. Dry-run
  and confirmation summaries do not read credential file contents or Keychain
  values; secrets are read only after the user proceeds.
- File-backed P0 adapters are implemented for Codex, Claude Code, and GitHub
  CLI.
- macOS Keychain import is an explicit source only:
  `--source keychain --keychain-service <service> --keychain-account <account>`.
  Clawdi does not guess Claude Code or GitHub Keychain item names. On non-macOS,
  Keychain import fails before reading anything. Keychain reads require an
  interactive confirmation and cannot use `--yes`. Materializing back into
  Keychain remains intentionally out of scope until a tool-specific import or
  verified item contract exists.

The first adapter set should stay narrow and explicit: Codex auth, Claude Code
credentials, and GitHub CLI hosts. Additional adapters for OpenClaw and other
local tools should follow the same import/materialize contract instead of each
inventing its own vault semantics.

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
- Connected account grants.
- Tool capability grants with scopes, constraints, and approval state.
- Workload identity bindings for providers that support short-lived identity
  federation.

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

4. **Local agent credential profile mode**
   - Clawdi stores an agent CLI's local credential profile as structured secret
     material plus a non-secret template.
   - A tool-specific adapter imports and materializes credentials for Codex or
     another local agent.
   - This is for compatibility with tools that expect local auth files instead
     of env vars.
   - Security claim: avoids manual token copying and supports backup/restore,
     but the materialized local file is plaintext to that tool and the local
     OS user.

5. **Tool authorization / capability mode**
   - Agent does not request a raw credential. It requests permission to call a
     Clawdi-managed tool, MCP server, or connected-account action.
   - User approval grants scoped capabilities such as `gmail.send`,
     `github.issue.create`, or `linear.issue.read`.
   - Clawdi stores the connected account and token lifecycle, then executes or
     authorizes the tool call under the approved scope.
   - This is the right direction for SaaS tools that support OAuth or a
     provider-specific delegated authorization flow.
   - Security claim: reduces agent exposure, but may still require Clawdi
     server-side token custody unless the tool gateway runs client-side or in
     an attested runtime.

6. **Deferred hosted-agent proxy mode**
   - Agent does not receive long-lived secrets.
   - Requests go through a credential proxy or tool proxy.
   - Proxy attaches credentials to outbound calls.
   - Add policy, rate limits, request audit, and host allowlists.
   - Requires controlled network egress, CA/proxy compatibility work, and
     careful request/response logging policy.
   - Treat as a later proof of concept, not Phase 1 or Phase 2.

7. **TEE-backed mode**
   - Decryption or proxy runs inside an attested confidential VM.
   - Useful for stronger "operator cannot inspect runtime memory" claims.
   - Requires separate Phala/dstack or confidential compute evaluation.
   - Second-pass search found strong Phala/dstack material for confidential
     agent runtimes, but no public evidence that OpenBao or Agent Vault has
     already been productized inside dstack as a reusable reference stack.

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
   - `credential_kind` (`secret_value`, `oauth_connection`,
     `local_agent_profile`, `service_binding`, `proxy_binding`,
     `workload_identity`, `delegated_tool_grant`)
   - `custody_model` (`client_managed`, `server_managed`, `tee_managed`,
     `external_provider`)
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
   - `credential_source_type`
   - `credential_source_id`
   - `service_name`
   - `host_pattern`
   - `path_pattern`
   - `auth_strategy`
   - `enabled`
   - `created_at`
8. `vault_connected_accounts`
   - `id`
   - `project_id`
   - `provider`
   - `external_account_id`
   - `display_name`
   - `scopes`
   - `token_ref`
   - `custody_model`
   - `refresh_policy`
   - `status`
   - `created_by_user_id`
   - `created_at`
   - `revoked_at`
9. `vault_capability_grants`
   - `id`
   - `project_id`
   - `agent_id`
   - `user_id`
   - `connected_account_id`
   - `capability`
   - `scopes`
   - `constraints`
   - `grant_token_hash`
   - `expires_at`
   - `revoked_at`
   - `created_at`
10. `vault_workload_identities`
   - `id`
   - `project_id`
   - `provider`
   - `issuer`
   - `audience`
   - `subject_template`
   - `credential_destination`
   - `custody_model`
   - `status`
   - `created_at`
11. `vault_credential_profiles`
   - `id`
   - `user_id`
   - `project_id`
   - `tool` (`codex`, `claude-code`, `gh`, later more allowlisted tools)
   - `profile`
   - `schema_version`
   - `encrypted_payload`
   - `nonce`
   - `custody_model`
   - `source_kind` (`file`, `keychain`, `tool_command`, `manual`)
   - `source_metadata`
   - `target_strategy` (`adapter_default`, `explicit`, `tool_login`)
   - `last_materialized_at`
   - `created_at`
   - `updated_at`
   - `revoked_at`

Phase 1 may implement a smaller table with only encrypted payload storage and
the `(project_id, tool, profile)` uniqueness rule. The important product
boundary is that credential profiles stay separate from `vault_items`, so
legacy all-env injection never receives complete local auth files by accident.

The `credential_kind`, `runtime_policy`, and `vault_service_bindings` fields
are future-proofing seams. Phase 1 can store only ordinary secret values, but
the model should not assume every credential is forever delivered as a raw env
string. Later proxy mode can attach a credential to a host/path service binding
without changing the user-facing `clawdi://` reference model.

The connected-account and capability-grant tables are not Phase 1 requirements.
They are included because second-pass research shows this category will matter:
OAuth and tool grants should become typed objects with revocation, scopes, and
audit, not opaque rows in `vault_items`.

`custody_model` is a required design axis, not only metadata. It controls the
security claim:

- `client_managed`: Clawdi stores ciphertext and cannot decrypt ordinary values.
- `server_managed`: Clawdi can use/decrypt the credential under policy, usually
  for OAuth refresh, hosted runtime delivery, or legacy server-side vault data.
- `tee_managed`: Clawdi service orchestration can request an operation, but the
  key use happens inside an attested runtime.
- `external_provider`: Clawdi stores a binding or trust relationship and asks
  an upstream provider to mint short-lived credentials.

For `local_agent_profile`, the credential may be `client_managed` or
`server_managed` depending on the phase. The materialized file is always local
plaintext for the target tool, so the product claim is backup/restore and
controlled sharing, not sandboxing.

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

Typed credential profile APIs:

```text
POST /api/vault/connected-accounts/authorize
POST /api/vault/connected-accounts/:id/refresh
POST /api/vault/credential-profiles
POST /api/vault/credential-profiles/resolve
POST /api/vault/capability-grants
POST /api/vault/capability-grants/:id/revoke
POST /api/vault/service-bindings/:id/session
```

These should share the same Project/Agent grant and audit machinery as secret
reference resolution. The difference is the delivered artifact: a resolved
secret value, a local agent credential profile, a short-lived access token, a
tool execution grant, or a proxy session.

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

### Option D: Local Agent Credential Profiles

Properties:

- Clawdi imports a supported local agent credential file or explicit
  credential-store export into a dedicated encrypted credential-profile record,
  separate from ordinary `vault_items`.
- The CLI can later materialize that profile back to the tool's expected path.
- This is useful for Codex, Claude Code on Linux/Windows, GitHub CLI file-backed
  auth, explicit macOS Keychain imports, and similar tools that expect local
  auth files or OS credential-store entries instead of per-command environment
  variables.
- The local materialized file is plaintext to the target tool and local OS
  user. A materialized Keychain or credential-store item is accessible under
  that OS account's credential-store rules. This is backup/restore and
  controlled sharing, not a sandbox.
- The stored profile should become client-managed once client-side encryption
  exists.

Use this as a narrow allowlisted adapter set, not a broad home-directory backup
system.

### Option E: Connected Account / Tool Authorization

Properties:

- User connects an account or approves a scoped tool capability.
- Agent receives a grant or calls a Clawdi-managed tool, not a broad raw
  credential.
- Scopes, consent, refresh, revocation, and audit are first-class product
  objects.
- Clawdi may still hold or refresh tokens unless the integration is
  client-managed, external-provider managed, or TEE-managed.

This is the recommended direction for SaaS and MCP integrations. It should be
designed with Vault because it shares Project/Agent grants and audit, but it
does not need to block Phase 1 secret references.

### Option F: Credential Proxy for Agents

Properties:

- Agent calls APIs through a proxy.
- Proxy attaches credentials.
- Agent never sees long-lived API keys.
- Works across SDKs/CLIs only when traffic can be forced through the proxy.
- Requires network control for strong enforcement.

This is the recommended secure-agent direction, but it is not recommended for
Phase 1. Treat it as a hosted-agent proof of concept after reference UX and
basic Vault maturity are in place.

### Option G: TEE Runtime

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

Phase 1 product objective:

> A developer can stop storing plaintext secrets in local project files, keep
> `clawdi://` references under version control, and run existing tools with
> those references resolved only at runtime.

Phase 1 is not a security rearchitecture. It is a product wedge that proves the
reference model, Project/Agent resolution semantics, and CLI/web workflow.

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
10. P0 local credential profile design and adapter spike:
   - detect supported Codex, Claude Code, and GitHub CLI credential paths
     without reading unrelated logs or history;
   - import only allowlisted files after a dry-run summary;
   - allow an explicit macOS Keychain/tool-command source only after the user
     chooses that source and confirms the system prompt risk;
   - materialize back to each tool's expected path with atomic write and
     backup, or through a verified tool login/import command.

Required behavior details:

1. `clawdi read`
   - Accepts one `clawdi://` reference.
   - Supports `--project`, `--agent`, `--json`, and `--debug`.
   - Prints plaintext only when the user explicitly asks to read a value.
   - Debug output shows provenance but never logs the secret value.
2. `clawdi run`
   - Reads references from explicit `--env-file` inputs and inherited env vars.
   - Resolves only references, not every secret in the Project.
   - Keeps legacy all-env injection behind `--all-vault-env`.
   - Supports `--no-inherit-env` for cleaner child-process environments.
   - Does not promise child-process stdout/stderr masking unless a separate
     non-TTY masking mode is explicitly enabled.
3. `clawdi inject`
   - Reads a template file or stdin.
   - Writes to a file or stdout.
   - Refuses to overwrite existing files unless `--force` is passed.
   - Prints a summary of resolved references and redacts values.
4. Batch resolve API
   - Accepts explicit references, Project/Agent context, and conflict policy.
   - Returns values plus provenance for CLI use.
   - Emits audit events for every resolved reference.
5. Web copy reference
   - Provides a stable reference for every field.
   - Indicates whether the reference is Project-relative or absolute.
   - Does not require revealing the plaintext value.

Defer from Phase 1:

1. Zero-knowledge marketing claims.
2. Full client-side encrypted vault migration.
3. OpenBao/KMS production adapter.
4. Hosted-agent proxy enforcement.
5. Dynamic secrets engines and full enterprise gateway deployment.
6. HTTPS proxy/MITM mode and CA injection.
7. Localhost sidecar service.
8. Broad credential-profile support beyond the P0 allowlist and any explicit
   macOS Keychain/tool-command bridge approved for those P0 tools.

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
7. Existing `clawdi run` users can still opt into all-env injection during the
   migration window.
8. The P0 adapter spike can show an import/materialize dry run for supported
   Codex, Claude Code, and GitHub CLI credential paths without reading logs,
   history, shell snapshots, or archived sessions.
9. On macOS, an interactive credential-store import is allowed only when the
   user explicitly selects that source, sees the target tool/account, and
   confirms before any Keychain or tool-token command is invoked.

Next-phase blockers with acceptance criteria:

- Audit trail: every reference resolve, credential-profile resolve, and
  materialization grant emits a durable event with actor, Project, Agent
  context, item reference, source kind, and request id, without secret values.
- Versions and rollback: vault item and credential-profile writes create
  version rows, expose latest/version metadata, and support restoring a prior
  version with audit.
- TTL and kill switch: runtime/service tokens can expire, and Projects, Agents,
  vaults, fields, and credential profiles can be revoked without deleting
  history.
- Key rotation and rewrap: server-managed encrypted payloads can be rewrapped
  under a new key, with migration status and rollback protection.
- Client-managed encryption: ordinary user vault values can be stored as
  client-encrypted ciphertext with local unlock/recovery; only then may product
  copy claim Clawdi cannot decrypt those values.
- Credential-store write-back: Keychain/Credential Manager materialization uses
  a verified tool import command or documented item contract, never arbitrary
  guessed rows.

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
  `credential_kind`, `runtime_policy`, local agent profile placeholders, and
  service-binding placeholders.
- P0 local credential profile adapters for Codex, Claude Code, and GitHub CLI
  backed by dedicated encrypted credential-profile storage, not `vault_items`,
  so legacy all-env injection never receives the stored auth file.
- Optional macOS interactive credential-store bridge for P0 tools, gated behind
  explicit source selection and adapter-specific verification.
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
- Typed credential foundations for `oauth_connection`, `service_binding`,
  `local_agent_profile`, `workload_identity`, and `delegated_tool_grant`.
- `custody_model` on credential records so API responses and product copy can
  distinguish "Clawdi cannot decrypt" from "Clawdi can use this credential
  under scoped policy."
- First-class agent actor identity in audit events, so secret reads, token
  refreshes, capability grants, and proxy sessions are attributable to a user,
  agent, Project, and runtime.
- Design spec for connected-account UX: provider connection, scope review,
  human approval, revocation, and per-agent grant visibility.
- Productionized P0 credential profile import/materialize flow if the Phase 1
  adapter spike proves stable enough.

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
- This statement does not cover explicitly server-managed connected accounts,
  proxy bindings, hosted runtime credentials, or external-provider workload
  identity bindings. Those credentials need their own `custody_model` label and
  product copy.

### Phase 4: Hosted-Agent Proxy / Tool Gateway PoC

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
- Tool/capability gateway for one OAuth-backed integration, so Clawdi can test
  whether "authorize an agent action" is a better UX than "give an agent a
  token" for SaaS tools.
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
5. Treat OAuth connected accounts, delegated tool grants, and workload identity
   as typed future credential modes, not as generic secret fields.
6. Treat Phala/dstack or other TEE deployment as a separate high-trust hosted
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

## Product Decision

Clawdi Vault should be positioned as:

> A Project-aware credential layer for AI agents and developer workflows.

Do say:

- "Use `clawdi://` references instead of plaintext secrets in files."
- "Resolve secrets through Project and Agent context at runtime."
- "Audit, expire, and revoke runtime secret access."
- "Credential custody is explicit: client-managed, server-managed,
  TEE-managed, or external-provider managed."
- "Future client-managed vaults can prevent Clawdi servers from decrypting
  ordinary item values."

Do not say yet:

- "Clawdi is zero-knowledge."
- "Clawdi cannot use or decrypt every kind of credential."
- "Clawdi run is a sandbox."
- "Agents cannot exfiltrate secrets."
- "Clawdi replaces your whole enterprise secrets platform."

The first product wedge is not "store secrets"; many products do that. The
wedge is "make credentials usable by agents with Clawdi's Project and Agent
semantics, without turning every workflow into plaintext env sprawl."

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
10. Which connected-account flow should be first?
   - GitHub App installation tokens may be the cleanest coding-agent wedge.
   - Google/Gmail is a stronger proof of human delegated consent, but has more
     review and compliance overhead.
11. Which credentials must remain server-managed for product functionality?
   - OAuth refresh tokens for hosted tools may need server custody.
   - Ordinary static API keys and `.env` replacements should move toward
     client-managed custody.
   - Enterprise customers may ask for external-provider or TEE-managed custody
     before allowing hosted agent execution.

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
  brokering: the open-source repo is MIT-licensed, while enterprise-only code
  should be treated separately; the design references are proxy/vault, dummy
  credential substitution, service rules, proposals, scoped sessions, and
  explicit "not a sandbox" caveats:
  <https://github.com/Infisical/agent-vault>
  <https://docs.agent-vault.dev/>
  <https://docs.agent-vault.dev/learn/security>
  <https://docs.agent-vault.dev/learn/services>
  <https://docs.agent-vault.dev/learn/proposals>
  <https://docs.agent-vault.dev/agents/overview>
- Authsome, Cred, and PassBox represent the newer agent-credential wave:
  local-first HTTP proxy brokering, OAuth delegation with short-lived access
  tokens, and zero-knowledge CLI/MCP workflows:
  <https://authsome.ai/>
  <https://www.cred.ninja/>
  <https://www.passbox.dev/>
- Keeper Secrets Manager CLI shows machine-oriented profiles, OS-native
  keychain storage, and environment substitution:
  <https://docs.keeper.io/en/keeperpam/secrets-manager/secrets-manager-command-line-interface>
- Claude Code's credential documentation defines the current platform split:
  macOS uses encrypted Keychain, Linux uses `~/.claude/.credentials.json`, and
  Windows uses `%USERPROFILE%\.claude\.credentials.json`:
  <https://code.claude.com/docs/en/team>
- GitHub CLI documents environment-token precedence, `gh auth token`,
  `gh auth login --with-token`, and `--insecure-storage`; these are the
  supported paths for explicit gh credential import/materialization design:
  <https://cli.github.com/manual/gh_help_environment>
  <https://cli.github.com/manual/gh_auth_token>
  <https://cli.github.com/manual/gh_auth_login>
- Apple Keychain access is explicitly mediated by app access groups,
  entitlements, and user/system authorization, which is why Clawdi should treat
  it as an interactive source rather than a plain file:
  <https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps>
  <https://support.apple.com/en-ca/guide/mac-help/kychn002/mac>
- AWS Secrets Manager Agent and HashiCorp Vault Agent show local/sidecar
  delivery patterns: localhost HTTP cache, read-only secret access, auto-auth,
  lease renewal, templating, and process-supervisor injection:
  <https://docs.aws.amazon.com/secretsmanager/latest/userguide/secrets-manager-agent.html>
  <https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent>
  <https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent/template>
- Akeyless is relevant as a SaaS secrets-manager proof point for
  customer-controlled cryptographic boundaries and gateway deployment patterns:
  <https://docs.akeyless.io/docs/universal-secrets-connector>
- Secretless Broker, Boundary, and Teleport show the broader infrastructure
  pattern: broker or inject credentials at a controlled boundary, and prefer
  short-lived workload identity over stored static secrets when possible:
  <https://www.conjur.org/api/secretless-broker/>
  <https://developer.hashicorp.com/boundary/docs/concepts/credential-management>
  <https://goteleport.com/docs/machine-workload-identity/>
- Composio is relevant for agent OAuth / connected-account UX, where the agent
  platform manages Connect Links, OAuth, token refresh, and credential handling
  for tool calls:
  <https://docs.composio.dev/docs/authentication>
- Arcade, MCP Authorization, Better Auth Agent Auth, and Grantex are relevant
  to the "authorization instead of secret delivery" direction: OAuth-backed
  tool calling, MCP authorization, agent capability discovery, user approval,
  short-lived JWTs, and auditable grants:
  <https://docs.arcade.dev/en/get-started/about-arcade>
  <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
  <https://better-auth.com/docs/plugins/agent-auth>
  <https://docs.grantex.dev/introduction>
- OpenBao Transit is appropriate for encryption-as-a-service, key rotation,
  rewrap, ACLs, and audit, but not as the Clawdi product model:
  <https://openbao.org/docs/secrets/transit/>
  <https://openbao.org/docs/audit/>
  <https://openbao.org/docs/concepts/policies/>
- dstack/Phala is relevant for future attested hosted-agent runtimes, not as
  the immediate Vault replacement:
  <https://github.com/Dstack-TEE/dstack>
  <https://phala.com/solutions/ai-agents>
  <https://phala.com/learn/Open-Source-Confidential-Computing-Tools>
