# Catalog cold-read optimization

Scope: complete eligible-catalog auth-config filtering plus one shared in-flight
index task. Detail's `managed_by=composio` membership gate is unchanged.

The scope is all custom-OAuth slugs from the full managed toolkit catalog,
before search/pagination. Cache reuse requires that exact set and the existing
five-minute TTL. SDK `toolkit_slug` receives sorted comma-separated slugs on
every page; `limit=50` remains. A local 4096-byte encoded initial-query budget
falls back to the original full scan, not an assumed provider URL limit.
Both paths retain only eligible slugs' enabled, custom, nonempty-scheme pairs.
Empty scope makes no request; malformed CSV slugs fail without upstream calls.

One task slot shares results/errors for equal scopes; a changed scope waits
for the old task to settle, then fetches its own coverage without inheriting
old provider errors. There is no multi-generation registry or failure cache.
Waiters use `shield`; canceling any/all requests does not cancel the fetch.
The 15-second fetch deadline covers all pages/SDK retries and maps to the
existing sanitized 504. Shutdown cancels/joins the task before closing clients.
Only complete results publish index/timestamp/scope. Different generations can
wait behind one old fetch; this bounds concurrency at the cost of that wait.

## Evidence

Root's authorized read-only probe (2026-09-10): 1520 managed toolkits, 171
eligible slugs, encoded filter 2347 bytes. Full index: five pages, 219 pairs,
2390.7 ms. Filtered index: one page, 25 pairs, 1518.7 ms; exactly equal to the
full index restricted to the eligible set. Catalog: two pages, 1523.1 ms.
This is one sequential provider sample, not a robust latency estimate.
The leaf read only the aggregate report; no provider/tenant credentials or
live calls, Hosted/reviewer writes, push, or merge.

Real pinned AsyncComposio SDK + HTTPX mock transport + actual FastAPI router,
Python 3.14.7 with locked dependencies, Docker 2 CPUs/3 GiB, network disabled.
Synthetic catalog: 1520 toolkits/171 eligible, 248 configs with 25 eligible;
1374 visible items verified through `/v1/connectors/available?page=1&page_size=24`.
Injected waits: catalog 760/763.05 ms, full index five times 478.14 ms, filtered
index 1518.73 ms. These encode the root's aggregate sample, not new network
measurements. One batch per N/variant; N=1 includes first-request SDK/schema
initialization. No provider queue/TLS/rate-limit model or statistical speed claim.

| Cold N | Total SDK calls before → after | Median cold ms before → after | Warm ms before → after |
| --- | --- | --- | --- |
| 1 | 7 → 3 | 4686.5 → 3710.9 | 16.6 → 22.2 |
| 4 | 22 → 3 | 4315.1 → 3328.2 | 10.8 → 17.2 |
| 8 | 42 → 3 | 4586.7 → 3367.8 | 11.1 → 13.6 |

Warm SDK calls: zero throughout. Warm times worsened in this single run;
full-scope derivation/checks add CPU work. Do not claim a warm improvement.
The earlier lock-only candidate did not reduce single-caller cold work and
was rejected because persistent failures retried serially across waiters.
Its original raw results remain in unpublished commit `bf629e531`; bulky
reports/fixtures are removed from the final tree.

## Verification

80 passed, 9 deselected: connectors, SDK/error/pagination, connector request
stages; only existing PostgreSQL metadata-batch and unrelated upload tests
excluded. Coverage includes multi-page filtered and oversized fallback reads,
encoded byte size, expiry, output filtering, concurrent different searches,
changed sets during/after success or failure, malformed/empty scope, cancellation
of first/second/all waiters, and shutdown joining provider cleanup.

Controlled two-page failure with eight waiters: status/cursor failure batches
102.0/102.3 ms for a 100 ms delay; shared 500 ms deadline batch 499.3 ms after
page-two entry. Each made two calls, returned the same exception to all waiters,
published nothing, and allowed the next independent request to retry.
BasedPyright service gate: zero diagnostics. Ruff lint/format, dependency
authority, and outbound API governance passed. No full database suite run.
