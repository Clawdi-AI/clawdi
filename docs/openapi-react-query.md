# OpenAPI React Query

The web app uses `useOpenApi()` from `apps/web/src/lib/api.ts` for ordinary
cloud-api reads and writes. It wraps the generated `paths` type with
`openapi-fetch` and `openapi-react-query`; callers use the generated
`[method, path, init]` query key rather than maintaining a parallel key.

The shared fetch client owns Clerk authentication, the 20-second request
ceiling, caller and TanStack abort propagation, transport error mapping, and
non-2xx conversion to `ApiError`. This keeps the existing QueryClient retry
policy, error panels, and mutation toasts consistent. Do not create another
OpenAPI fetch/query client in a feature module.

`useApi()` intentionally retains `openapi-fetch`'s typed `{ data, error,
response }` envelope for bespoke flows that branch on exact response status or
structured error bodies. Only `useOpenApi()` converts non-2xx responses to
`ApiError`; do not add that middleware to the shared raw client.

## Loading and refresh contract

- Use `isPending`/`isLoading` only for the first load while `data` is
  `undefined`. A stable skeleton may represent that unresolved layout.
- Treat `isFetching` as network activity, not as permission to restyle the
  current result. Background refresh must not change primary-content opacity,
  swap content for a skeleton, hide counts, revisit the empty-state decision,
  or replace usable content with an error panel.
- A refetch error with cached data keeps rendering that data. Use
  `shouldBlockQueryError(error, data)` where a component needs the shared
  blocking-error distinction. A resource-detail 404 is the intentional
  exception: deletion makes the cached entity no longer usable, so the not-found
  boundary is authoritative.
- User-triggered refresh may show a subtle local progress indicator. Track that
  action locally instead of presenting ambient polling or focus-refetch
  `isFetching` as user progress. Mutation-local progress remains appropriate.
- Polling must be bounded, disabled in background unless explicitly required,
  and must use stable path/query parameters. In this app, a poll is bounded by
  its mounted foreground surface, a recoverable transient state, or an explicit
  maximum-attempt/terminal condition. Every intended poll sets
  `refetchIntervalInBackground: false`. Query cancellation is supplied by
  openapi-react-query's propagated `AbortSignal`.
- Use `placeholderData: keepPreviousData` when a list identity changes through
  search, filtering, or pagination.

The paired-chat inventory is one reference polling case: its three-second
bindings refresh passes initial pending state, not background fetching state,
to the dialog. The same contract applies to Agent skills and sessions, channel
health, dashboard Agents, deployment reconciliation, and Wallet refreshes.

## Intentional TanStack Query exceptions

These cases remain explicit TanStack Query because the cache value or request
is deliberately different from one standard OpenAPI operation:

- Aggregations and projections: agent skill inventories, project skill/vault
  inventories, project bound-agent joins, hosted inventory, and session-message
  pagination combine multiple requests or pages into one cache entry.
- Uploads, downloads, and streams: skill archives, agent avatars, session
  artifacts, terminal/session streams, and connector authorization flows use
  `Blob`, `FormData`, streaming, or browser navigation semantics.
- Secret/sensitive caches: memory settings, vault items, API-key creation, AI
  provider credential acceptance/testing/OAuth, and Stripe client secrets
  remove secret material before QueryCache.
- Complex optimistic projections: agent/sidebar ordering and identity edits,
  API-key revoke, project membership/sharing, channel link/pair workflows, and
  skill/vault moves update or roll back several cache views atomically.
- Billing and deployment: `apps/web/src/hosted/billing/**` and deployment hooks
  retain their idempotency keys, reconciliation state machine, cross-service
  error model, and sensitive cache boundary.
- Hosted access and ownership sensors call a separately configured hosted API
  or derive cross-service state; they are not cloud-api OpenAPI operations.

An ordinary single OpenAPI operation with standard response caching is not an
exception. Add it through `useOpenApi()` and invalidate with its query option's
key or the matching `[method, path]` prefix.

## Upstream contracts

The integration was checked against official sources matching the lockfile:

- `openapi-react-query` 0.5.4 wraps TanStack query options, forwards the query
  context `AbortSignal`, and constructs the typed `[method, path, init]` key:
  <https://github.com/openapi-ts/openapi-typescript/blob/openapi-react-query%400.5.4/packages/openapi-react-query/src/index.ts>
- `openapi-fetch` 0.17.0 typed client and middleware implementation:
  <https://github.com/openapi-ts/openapi-typescript/tree/openapi-fetch%400.17.0/packages/openapi-fetch/src>
- TanStack Query 5.101.4 distinguishes initial pending state from background
  `isFetching`, retains prior pages with `keepPreviousData`, and supplies query
  cancellation:
  <https://github.com/TanStack/query/blob/%40tanstack%2Freact-query%405.101.4/docs/framework/react/guides/background-fetching-indicators.md>,
  <https://github.com/TanStack/query/blob/%40tanstack%2Freact-query%405.101.4/docs/framework/react/guides/paginated-queries.md>,
  and
  <https://github.com/TanStack/query/blob/%40tanstack%2Freact-query%405.101.4/docs/framework/react/guides/query-cancellation.md>.
- React 19.2.7 is the component/runtime contract used by these surfaces:
  <https://github.com/facebook/react/tree/v19.2.7/packages/react>.
- Base UI 1.6.0 and shadcn 4.16.1 provide accessible progress and skeleton
  primitives; they do not redefine query lifecycle state. Their versioned
  sources reinforce using those primitives as explicit task/placeholder UI,
  while TanStack remains authoritative for data state:
  <https://github.com/mui/base-ui/blob/v1.6.0/docs/src/app/%28docs%29/react/components/progress/page.mdx>
  and
  <https://github.com/shadcn-ui/ui/blob/shadcn%404.16.1/apps/v4/content/docs/components/base/skeleton.mdx>.
