# Portable API clients

`@clawdi/shared/api` exports `createCloudApiClient` and `createHostedApiClient`.
They take `{ baseUrl, getToken, fetch, timeoutMs?, observeResponse? }`. Supply the
platform fetch implementation (the native provider injects `globalThis.fetch`) and
an authenticated, account-generation-scoped token getter. No React, Clerk, DOM
lifecycle, billing mutation, or message sending implementation is imported.

| Client | Methods |
| --- | --- |
| Cloud | `listAgents(query?, signal?)`, `getAgent(id, signal?)`, `listSessions(query?, signal?)`, `getSession(id, signal?)`, `getSessionMessages(id, query?, signal?)` |
| Hosted | `listDeployments(signal?)`, `getDeployment(id, signal?)`, `getDeploymentByRequest(requestId, signal?)`, `getOperation(operationId, signal?)` |

Cloud also exposes generated-contract Project, Skill and Memory inventories,
dashboard statistics, Memory create/update/delete and Project create/update/archive.
These explicit mutations use the same authenticated, bounded transport; its
historical `read` name does not restrict the HTTP method. Mutations are never
automatically retried. After an uncertain result, refresh before an explicit retry.
Project ownership and kind restrictions remain authoritative on the server.
Memory search returns ranked top matches; do not append offset pages for a search.

`createAccountApiClient` exposes account settings and API key list/create/revoke.
Keep newly returned raw keys out of query caches, persistence and logs. Settings
editors must not send a masked secret back as a replacement value.

[`createProjectSharingClient`](project-sharing-client.ts) exposes owner-managed
links/invitations/members, stop-sharing, recipient invitations, link preview/join
and leaving a Project. Accepting an invitation or link
does not include any Agent IDs. Membership and ownership remain server decisions;
no share token is used as an authentication fallback. Newly created link URLs and
raw tokens must not enter query caches, logs or persistent storage. Native callers
must fence their presentation against blur, backgrounding and account retirement.

`createAgentProjectClient` exposes Agent Project bindings and context link/unlink/
reorder operations. `project-scope.ts` is also used by Web: the primary Workspace
is immutable, and the context reorder builder excludes it from mutation payloads.

`createSkillClient` uses explicit Project-scoped get/create/update/delete/install
routes. `skill-policy.ts` and `skill-content.ts` are shared by actual Web and native
consumers, not separate copies. Capture the content hash when editing starts;
never replace it with a background refetch's hash. Deletion requires a valid
captured hash. HTTP 412 must preserve the draft until explicit discard/reload.
GitHub input parsing rejects non-HTTPS URLs and ambiguous traversal. Skill
provenance and Project ownership remain server-enforced, regardless of UI policy.

`createSessionSharingClient` lists active snapshot/live links, creates explicit
public snapshots, revokes the exact `(kind, id)` link, and reads owner Markdown.
Revocation handles the generated 204 contract without changing empty-body rules
for other endpoints. Markdown uses the existing server serializer, not a client
reconstruction; reject HTML gateway responses even when they return HTTP 200.
Web and native share range construction and matching through `session-sharing.ts`.
Excerpt positions must come from `SessionTimelineMessageResponse.position`, never
from a filtered/paginated array index. Keep native share-sheet presentation fenced
against backgrounding, blur and account retirement. No public snapshot is created
implicitly by owner Markdown export.

Query types and inferred return types come from the existing generated
[`api.generated.ts`](api.generated.ts) and
[`deploy.generated.ts`](deploy.generated.ts), not handwritten response copies.
Use `environment_id` for the stable Agent id in Session list filters.
Transcript reads retain both message and tool-timeline projections, paging,
`content_revision`, and search-anchor fields. Pin subsequent pages to the same
revision; on HTTP 409 / `session_content_revision_changed`, discard the old
page set and re-read instead of merging revisions. These clients do not own
pagination accumulation or cache state.

The default 20-second ceiling includes token acquisition, HTTP, response
observation, and body parsing. Missing/failed tokens do not make anonymous
requests. Tokens are read per request; there is no retry, implicit token
refresh, persistent token cache, or purchase continuation. Pass an AbortSignal
to every account-owned read. Cancellation rejects with the caller's reason,
aborts the injected transport, and prevents a late token from starting a
request. A late response after cancellation cannot begin response observation.
`observeResponse` receives a clone before parsing; its callback must fence any
asynchronous account effects itself. Native auth/query providers still own
account-generation retirement, cache clearing, AppState and resume refresh.

Errors expose categories, never backend diagnostic copy:

- `ApiClientError`: HTTP `status`, structured `code`, and `category`
  (`unauthenticated`, `forbidden`, `not_found`, `conflict`, `rate_limited`,
  `server`, or `invalid_request`). A 401 is not automatically retried.
- `ApiClientNetworkError`: `kind` is `offline` or `timeout`.
- `ApiClientResponseError`: unreadable JSON, empty success, or failed response
  observation. Generated types do not constitute runtime payload validation.

Map these categories to the consuming app's i18n copy. Owner identity and
private/shared authorization remain server decisions. There is no owner-id
override, share-token fallback, or permission inference from a cached response.
Existing Web and Electron transports and error classes remain unchanged.
Hosted base URLs retain their proxy prefix and normalize a final `/v2`, matching
Web's existing base-url convention.

## Creation and future funding

Reuse [`deploy-wizard.ts`](deploy-wizard.ts)'s
`validateAndBuildHostedDeployRequest`, `buildHostedDeployRequest`, and
`projectHostedDeployRequest`. Deployments expose the authoritative stable
`agent_id`; Session associations must not depend on delayed runtime projection.
Hosted product access, included availability, reusable subscriptions, and
deployment `start_action` remain server-owned eligibility decisions.

The current generated funding union is Stripe/Wallet. Neither it nor the
Wallet path proves independent store-funded compute support. Do not invent
RevenueCat routes, product mappings, or a store continuation here. Adding
payment methods or regenerating Hosted contracts requires the Hosted owner's
reviewed immutable schema, source SHA, OpenAPI digest, generator command, and
compatibility results. Do not hand-edit either generated file.

## Verification

Run `bun run --cwd packages/shared test` through the repository Docker runner
after integrating the shared `openapi-fetch` dependency and frozen root lock.
Done: shared typecheck and tests exit 0. The focused `read-clients.test.ts`
suite uses container-local loopback HTTP plus injected failure transports;
it does not establish a native build, real Clerk login, or backend permission
parity. Web regression checks remain required before integration.

Vendor contracts: [openapi-fetch API](https://openapi-ts.dev/openapi-fetch/api)
and [0.17.0 implementation](https://github.com/openapi-ts/openapi-typescript/blob/openapi-fetch%400.17.0/packages/openapi-fetch/src/index.js).
