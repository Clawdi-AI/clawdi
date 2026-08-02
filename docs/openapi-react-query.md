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

- Use `isPending`/`isLoading` only for the first load when no data is present.
- A background `isFetching` state may add a quiet refresh affordance or opacity
  treatment, but it must keep the existing count, rows, dimensions, and empty
  state decision.
- A refetch error with cached data keeps rendering that data. Reserve blocking
  error panels for queries without usable data.
- Polling must be bounded, disabled in background unless explicitly required,
  and must use stable path/query parameters. Query cancellation is supplied by
  openapi-react-query's propagated `AbortSignal`.
- Use `placeholderData: keepPreviousData` when a list identity changes through
  search, filtering, or pagination.

The paired-chat inventory is the reference polling case: its three-second
bindings refresh passes `isPending`, not `isFetching`, to the dialog. Cached
chat rows and counts therefore do not flash on every poll.

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

- `openapi-react-query` 0.5.4:
  <https://github.com/openapi-ts/openapi-typescript/tree/openapi-react-query%400.5.4/packages/openapi-react-query>
- `openapi-fetch` 0.17.0:
  <https://github.com/openapi-ts/openapi-typescript/tree/openapi-fetch%400.17.0/packages/openapi-fetch>
- TanStack Query 5.101.4 background fetching and cancellation:
  <https://tanstack.com/query/v5/docs/framework/react/guides/background-fetching-indicators>
  and <https://tanstack.com/query/v5/docs/framework/react/guides/query-cancellation>
