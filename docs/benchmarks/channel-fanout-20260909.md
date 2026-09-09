# Bounded Gateway Link fanout measurement

Run from the repository root:

```bash
scripts/measure-channel-fanout.sh
```

Done: four parametrized cases pass and emit 12 `FANOUT` records. The opt-in
benchmark is skipped by default in normal pytest runs. The script pins Python
3.14.7 and verifies the repository's PostgreSQL 18.4 / vector 0.8.6 contract.
It mounts source read-only and installs locked dependencies only in its
disposable container. Runner limits are 2 CPUs / 3 GiB; PostgreSQL limits are
0.5 CPU / 512 MiB. Each case has a 90-second serving deadline; the runner has
a 600-second deadline, excluding a maximum 60-second PostgreSQL startup wait.
Cleanup removes only the script's containers/network and their ephemeral data.
It builds no image and does not remove shared images.

The measurement reuses the committed PostgreSQL lane, paired Discord account,
strict runtime state, real Uvicorn TCP WebSockets and shared advisory session
from `tests/test_channels.py`. External Discord metadata is a synthetic provider
fixture. No HTTP/TLS/provider latency is included. Authorization, dequeue SQL,
Link filters and sequence acknowledgements are real. No mocked global scan or
altered dequeue results are used.

One account has N=1/4/16/32 distinct authenticated Link consumers. Only the first
Link gets messages; all others remain connected and idle. The Gateway ordinary
pool is 8+0, acquisition timeout 5 seconds, and the existing fallback poll is
1 second. Its shared lock session occupies one ordinary-pool connection; the
PG listener is independent. The fixture's writer uses a separate engine.

Each case sends exactly 60 synthetic messages: 12 single-message commits at
250 ms scheduled intervals, 24 at 100 ms intervals, then six four-message
commits at 400 ms intervals. The driver waits for each batch's dispatches and
heartbeat acknowledgement before the next commit, so late batches can delay
the schedule. This is a bounded paced comparison, not an open-loop saturation
or maximum-throughput test. Setup is excluded, and each phase includes a
150 ms settling window to count trailing idle rechecks.

Latency starts when the producer's `commit()` returns and ends when the TCP
client receives `MESSAGE_CREATE`; it excludes commit execution and external
transport. SQL/message counts statements on the Gateway engine, including
receipt, authority, idle polling and shared-lock liveness SQL. It excludes
producer SQL and the independent listener. Pool timeouts count exceptions
observed in real dequeue calls; all sockets must additionally finish without
protocol errors. CPU is process CPU for the co-located application, client,
writer and probe, not server-only CPU or PostgreSQL CPU. Loop lag is lateness
of a 10 ms asyncio timer. Every dispatch is identity-checked, final-batch
receipts are queried from PG, and each idle socket must acknowledge a heartbeat
without a foreign dispatch ahead of it. Dedicated regression tests cover full
receipt/Resume behavior.

## Results (2026-09-09)

[Aggregate records](channel-fanout-20260909.jsonl) retain all 24 observations,
including fixed, steady and burst phases, loop lag distributions, CPU and wall
time. The account baseline is production code at `69f7ad493`; the targeted run
changes only the notification path and supplies the real Link ID to the same
measurement producer. Both complete matrices delivered all 240 messages and
passed all four cases (44.89 and 48.12 seconds of pytest execution respectively).
Earlier fixture bring-up failures are excluded from the comparison.

Steady phases contain 24 latency samples each. Percentiles use nearest rank;
no P99 or confidence interval is claimed. All observed dequeue pool timeout
counts were zero, with no socket failures in either complete matrix.

| N | Account p50/p95/max ms | Targeted p50/p95/max ms | SQL/message account → targeted | Empty queries account → targeted |
| --- | --- | --- | --- | --- |
| 1 | 13.41 / 17.14 / 17.80 | 23.74 / 27.73 / 28.30 | 8.125 → 8.125 | 24 → 24 |
| 4 | 20.12 / 30.68 / 35.66 | 24.64 / 28.55 / 32.10 | 11.167 → 8.500 | 97 → 33 |
| 16 | 28.08 / 38.97 / 50.84 | 24.17 / 32.20 / 37.10 | 23.125 → 9.792 | 384 → 64 |
| 32 | 55.55 / 92.82 / 93.96 | 33.89 / 88.55 / 465.52 | 39.083 → 11.292 | 768 → 100 |

At N=32 steady, targeted hints cut measured Gateway SQL/message by 71.1% and
empty queries by 87.0%. Remaining empty queries include the unchanged fallback
polling. Fixed-phase SQL/message falls from 40.000 to 16.333; burst-phase SQL
falls from 12.875 to 9.000. This is direct evidence for removing Account fanout.

The experiment does **not** establish a CPU or tail-latency improvement. Steady
process CPU (account → targeted, ms) is 562 → 870, 665 → 926, 904 → 979 and
1385 → 1439. N=32 targeted steady includes a 417.9 ms event-loop stall and
465.5 ms maximum dispatch latency; the baseline's largest fixed-phase stall
was 357.7 ms. Small-N latency also regressed in this sequential run. Allocation,
GC, scheduling and co-located driver costs are not separately attributed, so
these results must not be presented as a production latency/capacity guarantee.
The justified change is fewer useless DB queries, not a demonstrated CPU win.

## Notification contract

The existing PG channel carries either a legacy Account UUID or
`<account UUID>:<link UUID>`. New listeners validate both UUIDs for the extended
shape and ignore malformed extended payloads. They always notify unscoped
account consumers; scoped Gateway consumers receive only their Link hint.
Legacy Account payloads still notify all consumers of that account. Unknown
Link IDs produce no scoped wake and cannot authorize or dispatch a message.
No schema, receipt, Resume, authorization or polling-interval change is made.

Old publishers therefore wake new consumers normally. Old listeners treat the
extended payload as an unknown account key and recover through their existing
fallback timer; mixed deployment may temporarily regain polling latency.
The TCP phase regression runs both the new callback and the released raw-key
callback against real PostgreSQL, exercises targeted commits, listener loss,
legacy account notifications, foreign-Link isolation and durable receipts.
This is an in-process callback compatibility check, not a separately launched
old application binary. Existing database-backed Resume tests remain the
protocol authority. The raw-key callback run measured 521.9 ms p50 / 980.4 ms
p95; the listener-stopped sample delivered in 972.1 ms, consistent with the
unchanged one-second fallback.

## Verification

Focused Docker verification passed 100 tests in 52.78 seconds: sync events,
channel workers, Telegram waiting, channel inbox, consumer resource boundaries,
the two TCP notification callback cases, reader cleanup, durable Resume,
restart replay and shared-account Link bearer isolation. Ruff lint and format
checks passed for all seven changed Python files; the exact-path production
type gate analyzed four files with zero errors or warnings. Python 3.14.7
`compileall` passed for app, scripts, tests and Alembic, with bytecode confined
to the disposable container. The shell entrypoint passed `bash -n`. The test logs also
contained fixture runtime-state warnings and two non-failing asyncpg connection
close cancellation traces in existing TestClient protocol tests; they are not
latency samples. Every disposable test container was subsequently removed.
