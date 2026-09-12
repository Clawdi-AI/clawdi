# Recoverable sync module lifecycle

Implementation draft for owner review, 2026-09-12. The CLI implementation is in
[`sync-module.ts`](../../packages/cli/src/serve/sync-module.ts) and
[`sync-engine.ts`](../../packages/cli/src/serve/sync-engine.ts). This local
lifecycle does not change Cloud/Hosted wire contracts or Files/UI admission.

After shared Agent identity validation, Session and Skill slots prepare and run
independently alongside heartbeat, SSE and the durable queue. A missing adapter
capability is `unsupported`; `preparing`, `draining` and `retry_wait` retain queued
work without consuming its upload retry budget. Eligibility-aware queue waiting
avoids spinning on blocked items. Publication wakes the drain immediately.

Each attempt owns its cancellation scope. Queue uploads and Skill SSE callbacks
capture the prepared module, Project getter and hash map under a lease. Closing
an attempt prevents acquisition, aborts its HTTP reads, and joins scans, watcher
callbacks, reconciliation and leases before replacement. Project reassignment
also retires the binding before loading another Project's claims. Same-key queue
version and Agent/Project identity fences remain in place.

Preparation and worker failures retry from one second with exponential backoff
and jitter, capped at a 60-second base delay. One healthy minute resets backoff.
Module state/errors have independent SyncHealth keys. Global authentication
revocation and authoritative Agent disconnect still abort the daemon with exit
code 2, including during local retry. All workers settle before final queue
persistence and Vault cleanup; startup failure also runs that cleanup.

Adapter reads accept an optional `SyncReadContext`. Session iteration checks
cancellation between batches/files, database readers close in `finally`, and
OpenClaw command reads cancel and join their subprocess before releasing the
command slot. Foreground callers need not supply a context. Native SDK calls
without cancellation support and synchronous filesystem reads must actually
finish; a slot remains draining until they do. There is no abandoned-promise
replacement or guarantee against kernel-level uninterruptible I/O, shared disk
failure, or event-loop blocking inside a third-party reader.

## Verification

```bash
bash scripts/test.sh cli tests/adapters src/adapters/openclaw-workspace.test.ts src/serve/sync-module.test.ts src/serve/sync-engine.test.ts src/serve/queue.test.ts src/serve/sessions-watcher.test.ts src/serve/watcher.test.ts
```

Done: CLI typecheck and the selected tests pass in the hermetic runner. Scenarios
cover retained Session work while Skills and heartbeat progress through a failed
protocol preparation and recovery, cancellation while both an upload lease and
worker cleanup are held, auth revocation during retry, and joining an
unresponsive native command before its successor. Existing queue version,
watcher, adapter and global auth regressions run in the same suite. These are
local fault-injection results, not a released-CLI or live deployment guarantee.
