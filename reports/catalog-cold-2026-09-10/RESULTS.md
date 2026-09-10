# Catalog cold-read coalescing

## Result and scope

Add one asyncio lock around the existing custom-auth index cache check and
complete paginated fetch. No additional task, client, cache key, TTL, request
filter, or API behavior. The toolkit lock already coalesces its two pages;
this change coalesces the subsequent five auth-config pages too.

This reduces concurrent upstream work, **not the single-caller seven-page
critical path**. It does not fix the reported real cold latency of 3597 ms.
No provider calls, provider credentials, tenant metadata, or Hosted writes
were used. The root-provided page timings are inputs, not measurements made
by this benchmark. The named request-chain report was not present at the
specified Cloud/Hosted workspace paths; no private locations were searched.

## Controlled measurements

Python 3.14.7, locked backend dependencies (composio-client 1.43.0), Docker
containers limited to 2 CPUs / 3 GiB, network disabled. Real AsyncComposio SDK
with async httpx.MockTransport; real FastAPI connector router via ASGITransport.
Only authentication is replaced with a synthetic user dependency. No database
or ASGI application lifespan runs. Requests use the frontend's actual list
path and page size: `/v1/connectors/available?page=1&page_size=24`.

Synthetic metadata: 1100 toolkits across 2 pages, 248 custom configs across 5
pages, including custom OAuth toolkits. Each request verifies the final total,
page size, and enabled state. Injected page waits are 760/784 ms for toolkits
and 428/419/353/369/317 ms for configs (3430 ms total). The transport does not
model provider queuing, rate limits, TCP, TLS, or production payload parsing
costs. It therefore cannot establish real upstream latency savings.

One baseline and candidate batch at each N; cold caches reset before each
batch, followed by one warm request. Each variant runs in a fresh process;
N=1 includes first-request SDK/schema initialization, N=4/8 do not. Timing
variation is not a statistically established speedup. See raw JSON files for
individual request durations.

| Concurrent cold requests | Total SDK calls before → after | Median cold ms before → after | Warm ms before → after |
| --- | --- | --- | --- |
| 1 | 7 → 7 | 4143.9 → 4105.2 | 19.6 → 14.8 |
| 4 | 22 → 7 | 3745.1 → 3762.4 | 8.1 → 8.3 |
| 8 | 42 → 7 | 3804.4 → 3761.2 | 8.1 → 9.2 |

All warm reads made zero SDK calls. Toolkit calls remain 2; auth-config calls
fall from 20/40 to 5 at N=4/8 (75%/87.5% fewer config calls). No meaningful
single-caller latency improvement is claimed.

## Evidence and alternatives

- `apps/web/src/lib/connectors-data.ts`: list query uses `/v1/connectors/available`,
  detail uses `/v1/connectors/available/{app_name}`, both cache in the browser.
  `connectors-surface.tsx` uses the paginated list; connector cards prefetch
  detail/tools and `[name]/page.tsx` queries detail. These are distinct requests,
  not evidence that a single list request can skip full-catalog filtering.
- `get_app_by_name` retains the `managed_by="composio"` catalog-membership gate.
  The pinned retrieve response exposes `type`, `enabled`, and other fields,
  but their equivalence to list membership is not established. Arbitrary slugs
  remain untrusted. No detail optimization was made.
- The installed pinned SDK source (`sdk-contract.txt`) documents `toolkit_slug`
  as comma-separated slugs and serializes it as a query parameter. This permits
  scoped requests, but replacing the complete global index with a query subset
  would give subsequent searches incomplete authority. A separately scoped cache
  or comprehensive filtered index needs more design/evidence and is outside this
  minimal patch. No unverified filters or unconditional parallel fetch were added.
- The existing upstream cap workaround remains `limit=50`, despite the SDK's
  advertised 1000. All cursor and output filters are unchanged.

## Ownership and tradeoffs

The fetching request owns its SDK await. Canceling a waiter cannot cancel the
owner; canceling/failing the owner releases the lock and permits a waiter to
retry from page one. No shared background task retains a client beyond request
ownership. Partial pages never update the cache; the prior index and timestamp
remain untouched on failure. Persistent failures are retried serially by waiting
callers, which can increase their failure latency; this patch introduces neither
failure caching nor new timeout/retry policy.

Repository search found no external writes/invalidation of this metadata cache
in production: only initialization and successful fetch publish index/timestamp.
The existing timestamp is still taken before fetch, and TTL is checked inside
the lock. Thus this change does not add an invalidate-versus-refresh race. If a
future explicit invalidator is introduced, it must coordinate with this lock.
The cache remains deployment-wide as before; no tenant-specific cache is added
or broadened. `close_composio_client` is unchanged.

## Verification

- 69 passed, 9 deselected: connector service, SDK/error/pagination contracts,
  and connector request-stage routes. Excluded only the existing PG-dependent
  metadata batch route and eight unrelated upload-stage cases.
- Existing five-page completeness/normalization/expiry test now sends four
  concurrent cold reads through the real SDK transport and verifies one scan.
- Four interruption cases cover waiter cancellation, owner cancellation,
  translated SDK 503, and repeated cursor, including retry and no partial publish.
- BasedPyright `app/services/composio.py`: 0 errors, 0 warnings, 0 notes.
- Ruff lint/format for changed Python files: passed.
- Dependency authority and outbound API governance: passed.
- Image dependency installation used `uv sync --locked --no-install-project`.

## Reproduce

From the repository root:

```bash
docker build --memory=3g --cpu-period=100000 --cpu-quota=200000 \
  -t catalog-cold-check:20260910 \
  -f reports/catalog-cold-2026-09-10/Dockerfile .
docker run --rm --cpus=2 --memory=3g --network=none \
  -v "$PWD/backend:/src:ro" \
  -v "$PWD/reports/catalog-cold-2026-09-10:/reports:ro" \
  -e PYTHONPATH=/src catalog-cold-check:20260910 python /reports/benchmark.py
docker run --rm --cpus=2 --memory=3g --network=none \
  -v "$PWD/backend:/src:ro" -e PYTHONPATH=/src -w /src \
  catalog-cold-check:20260910 pytest -q -p no:cacheprovider \
  tests/test_connectors.py tests/test_composio_mcp_contract.py \
  tests/test_request_stage_routes.py \
  -k 'not test_connector_metadata_batch_reads_catalog_once_without_auth_details and not test_upload_stages_real_auth_pg'
docker image rm catalog-cold-check:20260910
```

Baseline measurements were taken on the unchanged service before applying the
lock, using the same benchmark. Containers auto-remove, source mounts are read
only for verification, and the task image and temporary files are removed after
verification. No push or merge; root/Fable review of the actual diff is pending.
