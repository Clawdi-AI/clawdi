# Telegram Link fanout: bounded ASGI comparison

Run from the repository root:

```bash
scripts/measure-channel-fanout.sh tests/test_telegram_fanout_load.py
```

Done: four cases pass and emit 32 `TELEGRAM_FANOUT` records. The default
pytest run skips this opt-in measurement. The existing runner pins Python
3.14.7, checks PostgreSQL 18.4 / vector 0.8.6, limits the runner to 2 CPUs /
3 GiB and PostgreSQL to 0.5 CPU / 512 MiB, and removes its own disposable
containers and caches. Its deadline is 600 seconds plus at most 60 seconds
of database startup; each case has a 90-second serving deadline.

This comparison exercises the real ASGI `getUpdates` route, including bearer
and routing-ID resolution, Link ownership and strict runtime authority in PG.
Only the database dependency is replaced with a factory yielding a **distinct
session per request**. Both authentication and subsequent short polling
transactions use the same ordinary 8+0 pool with a five-second acquisition
timeout. A separate committed fixture session produces messages through
`record_inbound_message`; it is never shared by concurrent requests. No
provider HTTP call, real Telegram account, TCP/TLS transport, mock dequeue
result or global inbox scan is involved.

All consumers share one synthetic account and have distinct Links, agents and
bindings. One Link receives updates; the other N−1 requests remain idle.
Waiting uses the production 30-second cap and five-second fallback. Both
strategies receive identical committed Link hints. `account` invokes the
pre-change waiting path by omitting the optional Link scope; `link` passes it.
The comparison changes only subscription selection, preserving identical
fetch functions, filters, offsets, authentication and transactions.

For N=1/16 the order is Account–Link–Link–Account; N=4/33 reverses the order.
Each of four blocks has eight single-message commits scheduled 750 ms apart,
then four three-message commits 400 ms apart: 80 messages per N, 320 per run.
Idle requests are cancelled and reauthenticated between blocks. Each block's
steady phase spans more than five seconds, so scoped results include genuine
fallback polls. The driver waits for a response and starts the next offset
request before the next scheduled commit; this is paced, closed-loop load,
not a maximum-throughput or open-loop saturation claim.

SQL/message counts all statements on the request/poll engine, including real
target reauthentication, retention, offset acknowledgement and idle polling;
initial block authentication and producer SQL are excluded. `empty_queries`
counts pages with neither returned updates nor committed progress;
`progress_pages` counts offset/filter progress separately. CPU includes the
co-located application, ASGI client, producer and probe, not PG CPU. Loop lag
is lateness of a 10 ms asyncio timer. No pool timeout may be hidden by a failed
request: all target requests must succeed, all idle requests must stay pending,
and cancellation must leave zero checked-out connections and subscriptions.

Latency runs from producer `commit()` return to ASGI response completion.
Responses must preserve the entire synthetic payload, including nested data.
Every update's receipt is checked in PG after the next offset request; subsequent
nonblocking calls on every Link must return empty. Invalid bearer auth must
return 401. Burst messages share one response and are correlated: the records
retain individual **response** latencies, and the tables below aggregate two
repetitions into 16 steady or eight burst response samples per strategy/N.
Percentiles use nearest rank; there is no P99 or capacity/SLO claim.

## Results (2026-09-09)

[Raw aggregate and response records](telegram-link-fanout-20260909.jsonl)
preserve both complete 320-message runs. Initial records deliberately rename
`empty_queries` to `empty_returns_including_progress`: that first counter also
included valid offset advancement. The second run separates those counters;
only its records feed the tables below. No first-run outlier was discarded.

For each N and strategy the tables combine the two interleaved repetitions.
SQL/message and CPU are means of the equally sized blocks. Empty pages are
sums across both repetitions. At these small response sample sizes, nearest-rank
p95 equals max; both are shown explicitly. Every observed pool timeout count
was zero.

Steady load (16 responses per strategy/N):

| N | Account p50/p95/max ms | Link p50/p95/max ms | SQL/message Account → Link | Empty pages Account → Link | CPU/block ms Account → Link |
| --- | --- | --- | --- | --- | --- |
| 1 | 12.47 / 49.99 / 49.99 | 13.80 / 43.77 / 43.77 | 10.000 → 10.000 | 16 → 16 | 559 → 565 |
| 4 | 27.93 / 35.99 / 35.99 | 13.91 / 29.25 / 29.25 | 16.000 → 10.750 | 64 → 22 | 624 → 586 |
| 16 | 71.68 / 83.31 / 83.31 | 13.51 / 15.06 / 15.06 | 40.000 → 13.750 | 256 → 46 | 1009 → 675 |
| 33 | 106.33 / 137.97 / 137.97 | 13.41 / 22.01 / 22.01 | 74.000 → 18.000 | 528 → 80 | 1387 → 761 |

Small bursts (eight responses, 24 messages per strategy/N):

| N | Account p50/p95/max ms | Link p50/p95/max ms | SQL/message Account → Link | Empty pages Account → Link | CPU/block ms Account → Link |
| --- | --- | --- | --- | --- | --- |
| 1 | 10.50 / 14.90 / 14.90 | 13.52 / 19.84 / 19.84 | 3.333 → 3.333 | 8 → 8 | 283 → 287 |
| 4 | 21.80 / 79.43 / 79.43 | 12.94 / 14.36 / 14.36 | 5.333 → 3.333 | 32 → 8 | 328 → 316 |
| 16 | 68.30 / 85.00 / 85.00 | 9.67 / 17.12 / 17.12 | 13.333 → 3.333 | 128 → 8 | 532 → 278 |
| 33 | 87.66 / 132.22 / 132.22 | 9.94 / 13.03 / 13.03 | 24.667 → 3.333 | 264 → 8 | 751 → 284 |

The N=33 steady comparison reduces SQL/message by 75.7% (74 → 18) and true
empty pages by 84.8% (528 → 80), while preserving all 16 offset-progress pages
in each strategy. Each unnecessary Telegram dequeue costs a retention UPDATE
and an inbox SELECT, explaining the Account fanout slope. Scoped steady work
still includes one five-second fallback poll from each idle Link per block.
The burst windows do not cross another fallback interval, so N=33 SQL/message
falls from 24.667 to 3.333. This does not imply idle polling has disappeared.

The repeat also supports a latency and process-CPU improvement at larger N,
not a production guarantee. N=1 has no query-count benefit, and its burst
latency/CPU can vary in either direction. Both runs include allocation/GC and
scheduler noise; the first N=33 Account steady block reached 474.86 ms, while
a first-run N=1 scoped sample reached 69.78 ms. The earlier
[Discord measurement and its unfavorable CPU/tail results](channel-fanout-20260909.md)
remain unchanged. No production inventory is treated as measured concurrency,
and this experiment does not measure HTTP keep-alive, TLS or provider transit.

## Decision and compatibility

Retain the small scope extension for review: the measurable Telegram query
reduction and repeated large-N latency/CPU gains justify passing the already
known Link ID. Production changes add one optional parameter and propagate it
through Telegram, WhatsApp and Link-aware generic inbox waits. No extra SQL,
schema, scheduling framework, polling interval or receipt/offset behavior is
introduced. WhatsApp shares the wait primitive; its compatibility is covered
by protocol regressions, **not** by a WhatsApp scale/latency claim. Nothing is
pushed, deployed or published by this task.

Legacy Account payloads continue waking all subscribers of that account.
Generic callers without a Link ID retain Account subscriptions and receive
both legacy and extended hints. New publishers with old raw-key listeners
can miss the extended hint and regain the unchanged polling latency: five
seconds for these waits, versus the existing one-second Discord fallback.
Database filtering, Link/session authority and durable receipt/Resume remain
the correctness boundary. Mixed deployment therefore has a temporary latency
cost and must not be described as uniformly immediate delivery.

## Verification

The final Docker run passed 135 cases in 218.79 seconds, including the four
measurement cases, four real-PG protocol compatibility cases, Telegram page
progress/offset/cancellation, channel inbox and sync tests, WhatsApp Noise
transport/authentication/rotation/archive tests, worker and consumer resource
boundaries, and Discord TCP legacy-callback/reader/Resume/isolation regressions.
The first measurement-only run passed four cases in 147.05 seconds; total
measurement traffic across the two complete runs was 640 synthetic messages.

The protocol-specific compatibility cases observe an actual empty page **after
its short transaction has closed** before committing a message. Targeted and
legacy Account payloads both deliver through the real listener. The released
raw-key callback misses the Link hint and the unchanged fallback delivers in
5.014 seconds (Telegram), 5.006 (WhatsApp), 5.010 (Link inbox) and 5.006
(unscoped inbox). Each wait also parks and cancels without retaining a pool
connection or either subscription map. This checks the old callback semantics
in-process, not a separately deployed old application binary.

Ruff lint and format checks passed for five changed Python files. Exact-path
production type checking analyzed three files with zero errors/warnings.
Python 3.14.7 `compileall` passed for app, scripts, tests and Alembic with
bytecode confined to a disposable container. Existing TestClient protocol
fixtures emitted non-failing asyncpg cancellation/connection-lost teardown
diagnostics; these are outside the ASGI load samples. All task-owned containers,
networks, temporary logs and caches were removed; shared images were retained.

## Final N=1 qualification on main 66c21f7d3

The unpublished branch was rebased without conflicts onto `66c21f7d3` (#1460,
provider HTTP keep-alive). `git range-diff` reports both patches unchanged:
`aebdd30e7 → 972d994b7` and `3b4954998 → 5eea266ce`. The measured runtime head
was `5eea266ce`; subsequent qualification changes only append evidence. No
provider HTTP path is exercised by this ASGI benchmark, so differences from
the earlier run cannot be attributed to keep-alive by this experiment.

The existing N=1 case was run once, unchanged: four ABBA blocks, 80 messages,
the same Python/PG versions, resource limits, pool, wait cap and fallback.
No test cases or framework were added. Reproduce the measurement with:

```bash
scripts/measure-channel-fanout.sh 'tests/test_telegram_fanout_load.py::test_telegram_fanout[1]'
```

Done: one case passes and emits eight records. They are appended to the raw
JSONL under `run=n1-qualification-66c21f7d3`; all 64 preceding records and the
original tables remain intact.

| N=1 phase | Responses/strategy | Account p50/p95/max ms | Link p50/p95/max ms | SQL/message Account → Link | Mean CPU/block ms Account → Link |
| --- | --- | --- | --- | --- | --- |
| Steady repeat | 16 | 13.037 / 27.684 / 27.684 | 12.925 / 16.016 / 16.016 | 10.000 → 10.000 | 570.823 → 751.353 |
| Burst repeat | 8 | 11.059 / 14.193 / 14.193 | 12.854 / 15.305 / 15.305 | 3.333 → 3.333 | 283.270 → 294.286 |
| Earlier burst | 8 | 10.499 / 14.900 / 14.900 | 13.524 / 19.841 / 19.841 | 3.333 → 3.333 | 283.318 → 287.168 |

The aggregate adverse burst direction persists, with a smaller absolute gap:
p50 +1.795 ms and p95/max +1.112 ms, versus approximately +3.025/+4.941 ms
previously. Burst process CPU is 3.9% higher. The individual scoped burst
blocks differ substantially (p50 14.677 and 7.527 ms), and the scoped steady
CPU blocks are 946.948 and 555.757 ms. Keep those unfavorable measurements;
there is no N=1 SQL saving and no demonstrated zero-overhead guarantee. This
single bounded repeat neither isolates a causal subscription cost nor proves
statistical significance. The larger-N benefit remains the reason for the
change, with the small-N cost left explicit for review.

The combined qualification command passed **21 existing cases in 63.65 s**:
N=1 load, protocol wait compatibility, Telegram page/offset/cancellation,
provider HTTP reuse and all three TLS keep-alive cases, inbound hint
commit/rollback/legacy behavior, and Discord reader cleanup. Pool timeouts
were zero; payload, durable offsets, isolation and cancellation assertions all
passed. Ruff lint/format passed for all five production paths. Exact-path
typing analyzed `app/routes/channel_routers/discord.py`,
`app/routes/channel_routers/whatsapp.py`, `app/services/channel_wakeups.py`,
`app/services/channels.py` and `app/services/sync_events.py`, with zero errors,
warnings or information diagnostics. Task-owned containers, network and
transient caches/logs were removed. No push, PR or deployment was performed.
