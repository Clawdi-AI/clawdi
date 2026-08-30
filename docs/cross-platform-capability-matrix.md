# Cross-Platform Client Capability Matrix

Baseline: 2026-08-30. Web is the current reference implementation. Desktop and
Mobile columns define approved first-release behavior; they do not claim those
clients are shipped.

Support terms match
[`PlatformCapabilities`](../packages/shared/src/client.ts): **direct** runs in
the client, **adapted** preserves the outcome with platform-native interaction,
**handoff** opens the owning client or service, **policy-gated** requires store
policy approval, and **unsupported** is omitted with no inert control. Account
permissions and Hosted entitlements still apply after platform support.

## Experience Matrix

| Current Web surface | Web behavior | Approved Desktop target | Approved Mobile target | Parity exit |
| --- | --- | --- | --- | --- |
| Auth and account (`/sign-in`, `/sign-up`, Settings) | Direct Clerk auth; profile and API keys in Settings | Adapted system-browser auth; same profile and key outcomes | Adapted secure auth; profile direct, API-key management omitted initially | Sign-in return target and account identity match Web; secrets are never persisted outside platform-secure storage |
| Home and Agent inventory (`/`, `/agents`, `/agents/$id/**`) | Direct Cloud inventory; Cloud/Legacy/Connected ownership badges; unresolved ownership fails closed | Direct merged local-first and Cloud inventory with the same identity, ownership, and health terms | Direct Cloud inventory only; no local scanning | The same Cloud Agent has the same name, ownership, health, default detail destination, and available actions |
| Connect and disconnect local Agents (Agents onboarding, Agent Settings) | CLI setup handoff; direct disconnect only for resolved Connected machine-key Agents | Direct discovery/setup and the same disconnect contract | Unsupported; controls omitted | [`agentDisconnectEligibility`](../packages/shared/src/client.ts) passes contract tests and Web keeps its existing visible/hidden decision |
| Cloud Agent provisioning and lifecycle (`/deploy`, Cloud Agent detail) | Direct when Hosted entitlement permits; start/stop/restart/delete follow projected lifecycle status | Direct with identical entitlement, confirmation, progress, retry, and failure semantics | Adapted native controls for safe lifecycle operations | Seeded status and entitlement inputs produce the same action set and accepted-operation outcome |
| Cloud Agent interface, Files, logs, and terminal (`/agents/$id/*`, `/terminal/$id`) | Direct browser surfaces; runtime readiness is distinct from deployment status | Direct renderer surfaces | Adapted touch UI; xterm only in an isolated WebView, never a local terminal | Readiness failures retain the same public category and recovery path; credentials never enter URLs or renderer storage |
| Sessions and public sharing (`/sessions`, nested Agent sessions, `/s/$id`, `/share/$token`, `.md`, `.json`) | Direct browse/search/detail/share/export with server permission checks | Direct, with local sessions shown before Cloud sync where available | Adapted browse/chat/share using native navigation and share controls | Deep links resolve to the same Session; private and public access decisions and export content remain equivalent |
| Projects and access (`/projects`, `/projects/$id`, Agent project access) | Direct create/link/share; only owned custom Projects are mutable | Direct with the same ownership rules | Direct browse and membership context; mutation controls omitted initially | Project kind, owner badge, linked Agents, and read/write eligibility match Web |
| Skills (`/skills`, `/skills/$key`, Agent Skills) | Direct Project Skill management; synced, Agent Workspace, unresolved, and shared Skills are read-only | Direct; local inventory may precede Cloud projection | Direct browse; management omitted initially | Authority and Project ownership produce the same read-only projection and provenance label |
| Vaults (`/vaults`, `/vault`, detail and Agent Vaults) | Direct owner-gated create/edit/copy/move/attach; legacy `/vault` aliases remain | Direct Cloud management plus native local injection through the CLI boundary | Unsupported initially; local Vault injection is excluded | Owner/non-owner mutation eligibility and sensitive-data redaction match Web; no secret enters logs or caches |
| Memories (`/memories`, `/memories/$id`, Agent Memories) | Direct account-wide create/search/delete | Direct | Direct browse; mutation omitted initially | Category, search result, detail, and account-wide scope match Web |
| Connectors (`/connectors`, detail) | Direct catalog, OAuth, credentials, and readiness | Direct with system-browser OAuth handoff | Unsupported initially | Authorization return targets, readiness, and credential redaction match Web |
| Hosted Channels and AI Providers (`/channels`, `/ai-providers`, OAuth callback) | Direct in Hosted builds; management is provider/runtime capability-gated | Direct | Channels adapted; AI Provider management omitted initially | Linked-account state, channel health, and unavailable-provider behavior match Web |
| Billing and usage (Settings Hosted sections) | Direct checkout, subscription, wallet, and usage surfaces | Direct | Read-only usage; purchases policy-gated and omitted until approved | Entitlement and usage values match; Mobile exposes no purchase route before store-policy approval |
| CLI authorization (`/cli-authorize`) | Direct browser approval for the external CLI | Handoff from bundled CLI to the system browser | Unsupported | Approval returns only to the requesting CLI flow and is absent from Mobile navigation |

Compatibility routes such as `/vault/*` are Web aliases, not separate product
capabilities. Route layouts, dialogs, tables, drawers, native stacks, and sheets
remain client-owned presentation.

## Current Decision Owners

| Decision | Current source | Invariant |
| --- | --- | --- |
| Platform support and Connected Agent disconnect | [`packages/shared/src/client.ts`](../packages/shared/src/client.ts) | Platform support is checked before rendering; unresolved or external ownership and explicit identities fail closed |
| Agent navigation and overview modules | [`apps/web/src/lib/navigation-model.ts`](../apps/web/src/lib/navigation-model.ts) | Connected and Cloud Agents expose only sections backed by their run path |
| Cloud lifecycle status and actions | [`apps/web/src/hosted/deployment-status.ts`](../apps/web/src/hosted/deployment-status.ts) | Unknown status disables actions; start is stopped/failed, stop is starting/running, restart is running/failed |
| Hosted product access | [`apps/web/src/hosted/access/product-access-model.ts`](../apps/web/src/hosted/access/product-access-model.ts) | New deployment surfaces require `can_use_v2`; existing deployment management remains discoverable |
| Skill mutation | [`apps/web/src/lib/skill-authority.ts`](../apps/web/src/lib/skill-authority.ts) | Synced, Agent Workspace, shared, or unresolved Skills are read-only |
| Project and Vault mutation | [`project-metadata.tsx`](../apps/web/src/components/projects/project-metadata.tsx) and Vault surfaces | Only owners mutate custom Projects or Vault contents |

## Exit Criteria

- Every checked-in Web route belongs to a row above; new route families update
  this matrix in the same change.
- Shared projections and action rules stay UI-framework-free and have focused
  contract tests. Clients do not fork these rules into view components.
- Unsupported actions are omitted or provide the documented handoff. Permission,
  entitlement, loading, and unknown states fail closed.
- A vertical slice exits only when its seeded semantic outcome matches Web and its
  platform boundary is tested directly; pixel equality is not required.

Done: `bun run --cwd packages/shared test` and
`bun run --cwd apps/web test src/components/dashboard/agent-settings-panel.logic.test.ts`
exit 0.
