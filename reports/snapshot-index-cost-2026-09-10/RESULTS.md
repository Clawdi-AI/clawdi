# Bounded session search insertion — 2026-09-10

The snapshot and event search writer sends one parameterized PostgreSQL
`INSERT SELECT FROM unnest` per 500 documents instead of executing one INSERT
per document. All search indexes, constraints, chunk boundaries, revisions and
transaction boundaries remain unchanged. A mapped SQLAlchemy insert with
`dml_strategy="raw"` retains Session autoflush, including pending event
generations; it does not access the raw driver.

## Measurement

Baseline: `32c334af1e2e6da6ed2fe4c7c7afb3d7a39ab593`. Python 3.14.7,
PostgreSQL 18.4, frozen dependencies (SQLAlchemy 2.0.52, asyncpg 0.31.0),
runner 2 CPU/3 GiB, PostgreSQL 0.5 CPU/512 MiB. PostgreSQL uses a disposable
local disk volume with real commits, not an outer rollback/savepoint.

Each variant starts from a clone of the same committed database template,
including old target rows and 10,040 background documents. GIN pending
pages/tuples are checked against the template; the final large-input template
is measured with background autovacuum disabled in the disposable PostgreSQL
server, so it cannot change between clones. Synchronous GIN maintenance is
unchanged. No product or production autovacuum setting is changed. All five
production-defined search indexes and constraints are present. Synthetic messages
mix prose, code, paths, hex identifiers, CJK, accents and emoji; every 251st
message spans overlapping chunks. The large case contains 23.66 MB of message
content and 30,120 search rows, with approximately 72 MB of initial total table
and index storage. This is not a simulation of a multi-million-row installation.

Index stage wall time, medians in milliseconds (includes deletion, excludes commit):

| Messages / documents | Runs per variant | Baseline | UNNEST | Change |
| --- | ---: | ---: | ---: | ---: |
| 0 / 0 | 2 | 6.63 | 3.91 | Noise-scale |
| 100 / 101 | 6 | 110.19 | 106.92 | -3.0%, noisy |
| 5,000 / 5,020 | 2 | 6,617.53 | 5,841.80 | -11.7% |
| 30,000 / 30,120 | 3 | 43,704.81 | 37,288.91 | -14.7% |

The large-case samples are baseline 49,798.5 / 43,704.8 / 42,756.1 ms and
candidate 37,288.9 / 36,780.5 / 38,346.2 ms. Every clone starts with FTS
72 pages / 605 pending tuples and trigram 505 / 505, and finishes at FTS
512 / 4,374 and trigram 240 / 240. Checks assert the starting state.
Small/medium cases retain background autovacuum; their recorded starting and
ending pending states also match within each size.

Final-source verification uses ABBA for empty/5,000 inputs and three ABBA
cycles for 100 inputs. The large case uses ABBAAB with the immutable template.
Earlier large-input measurements allowed autovacuum to mutate an idle template;
those pooled medians are rejected, not mixed into these results. Raw samples
and attribution probes accompany this report in [measurements.jsonl](measurements.jsonl).

For 30,120 rows, PostgreSQL executes 61 insert statements instead of 30,120.
Median backend process CPU falls from 18.70 to 15.77 seconds (-15.7%), and
Python process CPU from 2.82 to 2.09 seconds. Maximum observed loop lag falls
from 98.0 to 23.1 ms. Delete cursor time is 91.5 / 76.9 ms and real commit
17.7 / 10.4 ms; insertion remains the dominant stage. Server insertion time
from pg_stat_statements is 41.45 / 36.55 seconds, including index work and CPU
throttling. Python, cursor and server timings overlap and must not be summed.

Independent attribution probes on 5,020 documents report median text scanning
11 ms, `to_tsvector` 1,330 ms and `show_trgm` 2,197 ms. These different queries
are not an exact decomposition of GIN insertion. A committed EXPLAIN ANALYZE
insertion of 502 rows takes 475.7 ms: source scanning 0.65 ms and foreign-key
triggers 7.8 ms. FTS pending pages falling 499 to 44 coincide with a 1,112 ms
message batch, versus adjacent 507 / 563 ms batches. This demonstrates periodic
maintenance, not a claim that FTS explains every spike. The minimal change
reduces repeated statement execution and per-row parameter handling while
retaining lexical computation and synchronous index maintenance.

Small-input measurements are noisy at this CPU quota. They did not justify a
second insertion path or an input-size threshold. No end-to-end production
latency improvement is claimed: input sizes of the motivating requests were
unknown, and object storage can independently dominate uploads.

## Verification

The committed change was rebased onto
`2def90cce8c325900ed3faf5af51fb075215b82a` without conflicts. That update changes
only the connector catalog service/tests and its report. Final verification
results are recorded after the rebase; no further performance matrix is run.

After rebase: **31 passed, 1 known xfailed** in 36.67 seconds. The single
warning is an existing deprecated HTTP 422 constant. Ruff lint/format pass;
focused basedpyright reports **0 errors, 0 warnings**. Compiled final SQL is
byte-for-byte equal to the measured statement after spelling UUID types as
explicit instances for type inference.

With frozen dependencies, a migrated throwaway PostgreSQL and a writable
container-local file store, the relevant checks are:

```bash
cd backend
uv run --no-sync python -m pytest -q -p no:cacheprovider \
  tests/test_session_search.py tests/test_session_events.py \
  tests/test_session_search_chunk_migration.py tests/test_asyncpg_close_timeout.py
uv run --no-sync ruff check --no-cache app/services/session_search.py \
  tests/test_session_search.py tests/test_session_events.py
uv run --no-sync ruff format --check --no-cache app/services/session_search.py \
  tests/test_session_search.py tests/test_session_events.py
uv run --no-sync basedpyright app/services/session_search.py
```

All commands exited zero. The initial read-only file-store test configuration
was fixed only in the isolated harness, with `FILE_STORE_LOCAL_PATH` pointing
to the container's temporary directory.

The pending-generation regression specifically prevents replacing mapped
Session execution with a Core table insert that would skip autoflush. Existing
search tests cover literal wildcards, roles, owner isolation, full-text ranking,
chunk overlap, navigation, revisions and the duplicate-in-last-batch rollback.
Task-only checks also exercise that rollback with real commits and an
independent reader. One real PostgreSQL cancellation regression locks the parent
Session in another connection, observes the actual UNNEST INSERT waiting on
that foreign key, then cancels it. The writer backend disappears and the pool
returns to zero checkouts before unlocking the parent; a fresh read still sees
the original snapshot/revision. The existing network-stall xfail is not used
as evidence for ordinary cancellation.

Contracts checked against PostgreSQL 18 multi-array UNNEST documentation and
SQLAlchemy 2.0.52 `BulkORMInsert.orm_pre_session_exec`: the arrays always come
from the same zipped rows, and the mapped raw DML strategy still autoflushes.
