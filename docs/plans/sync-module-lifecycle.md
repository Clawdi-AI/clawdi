# Recoverable sync module lifecycle

Draft for owner review, 2026-09-12. This specifies the remaining within-Agent
sync isolation change; it is not an implemented guarantee. No Cloud/Hosted wire
schema, Files credential proof, model, or native service policy changes are needed.

## Why a local catch is insufficient

[`runSyncEngine`](../../packages/cli/src/serve/sync-engine.ts) prepares sessions
then Skills before starting either worker, heartbeat, or drain. A preparation
failure exits the engine. `runDaemonWorkers` then aborts its observation worker.
Preparation currently has no independently owned cancellation scope.

The data adapter contract in
[`base.ts`](../../packages/cli/src/adapters/base.ts) exposes Promise-returning
`contentProtocol`, `collect`, `scan`, `resolve`, and `listKeys` without an abort
context. [`watcher.ts`](../../packages/cli/src/serve/watcher.ts) and
[`sessions-watcher.ts`](../../packages/cli/src/serve/sessions-watcher.ts) close
their watchers on abort, but their callbacks return void. The callbacks launch
scans/enqueues without an awaitable close boundary. Merely retrying preparation
does not address already-started work or the drain's mutable hash maps.

## Proposed internal API changes

Add `serve/sync-module.ts` with these internal contracts. `Binding` is the
existing queue module plus its `lastPushedHash` map, published as one object:

```ts
type ModuleState =
  | "unsupported"
  | "preparing"
  | "ready"
  | "draining"
  | "retry_wait"
  | "stopped";

interface ModuleLease<Binding> {
  binding: Binding;
  signal: AbortSignal;
  release(): void;
}

interface PreparedModule<Binding> {
  binding: Binding;
  run(): Promise<void>;
  close(): Promise<void>;
}

interface ModuleSlot<Binding> {
  readonly state: ModuleState;
  acquire(): ModuleLease<Binding> | null;
  run(): Promise<void>;
  close(): Promise<void>;
}
```

`ModuleSlot` owns one attempt controller and at most one prepared instance. Its
factory takes `{ signal, track }`; `track(promise)` registers every scan,
watcher callback and project reconciliation before returning control to its
caller. Factory failure closes this scope even if no PreparedModule was returned.
`close()` is idempotent: reject new leases, abort the attempt, close watchers,
then join tracked tasks and drain/SSE leases. Only then discard the binding and
construct another attempt. A swallowed rejection is not a completed module.

Session binding retains `{ module, protocol, lastPushedHash }`; Skill binding
retains `{ module, getProjectId, lastPushedHash, onEvent }`. Do not move the
project getter or maps into unrelated mutable globals. A lease captures one
binding through an entire queue upload and its version-fenced acknowledgement.

Change `watchSkills.onSkillChanged` and `watchSessions.onPathStable` to accept
`void | Promise<void>`. Watcher shutdown must wait for callback promises, and
the sync preparation functions must return their enqueue/scan promises instead
of discarding them. Keep callback coalescing; do not serialize independent
filesystem events behind a stalled network request.

For bounded cancellation, extend adapter read operations with an optional
`SyncReadContext = { signal: AbortSignal }` argument: SessionModule
`contentProtocol(context?)`, `collect(request, context?)`,
`scan(request, knownRevisions, context?)`, `resolve(id, context?)`, and SkillModule
`collect(context?)`, `listKeys(context?)`. Thread it through `scanSessionModule`
and the six adapter implementations. Existing foreground callers remain valid.
Iterators check abort between batches and close DB/file handles in finally;
network/subprocess reads use the signal. No cancellation may infer local absence
or mark a scan complete. This is a local TypeScript contract, not a generated
HTTP API change. Writes/removals keep their existing ownership checks.

## Engine and queue integration

1. Keep initial Agent/registration identity validation as a shared startup
   prerequisite. After it succeeds, start slots, heartbeat, SSE, and drain
   together. Preserve one shared queue and one heartbeat per Agent.
2. Use `unsupported` only when the adapter does not implement the module.
   `preparing`, `draining`, and `retry_wait` are unavailable but retain all
   queued work. Existing unsupported-module drop behavior remains explicit.
3. Extend `RetryQueue.peek` with an eligibility predicate and add
   `waitForChange(signal, timeoutMs)`, which waits for a new queue/slot event even
   when the queue is nonempty. Drain selects an eligible item, acquires its
   module lease synchronously, then awaits upload. If none is eligible, wait;
   do not call the current `waitForItem` and spin on retained blocked work.
   Slot publication wakes drain. Skip unready items without incrementing attempts
   or drop counts. Preserve same-key version guards, identity fences and normal
   upload retry budgets.
4. Run queue HTTP calls under the lease signal combined with Agent shutdown.
   Update queue/hash/claims only under that lease and current version. Closing
   a module waits for this work before reloading its hash maps. A lease cancelled
   by module shutdown retains the queue item and does not exhaust its retries.
5. SSE acquires a Skill lease before onEvent; otherwise ignore the wakeup and
   rely on the next complete startup scan. Vault-only auth handling remains
   separate. Decide global SSE auth failure from adapter capability, not whether
   the Skill slot happens to be ready.
6. On recoverable preparation/run failure: `ready -> draining -> retry_wait ->
   preparing`. Backoff starts at 1 second, doubles to 60 seconds with jitter,
   and resets after one healthy minute, not after merely constructing a worker.
   Publish module health errors through existing SyncHealth; healthy module
   success must not clear another module's error.
7. Identity revocation/disconnect and authoritative auth failure still invoke
   the existing global abort/exit-code-2 path. These never enter local retry.
   Engine finally closes slots, joins heartbeat/SSE/drain, flushes the queue,
   and calls Vault finish even when startup preparation failed.

If an old adapter cannot cancel an in-flight read, its slot stays `draining`
until it actually completes; expose that state and never overlap a replacement
worker. Other slots and runtime observation continue. Do not implement a
Promise.race deadline that abandons a writer while claiming cleanup succeeded.
The adapter context work is required to make shutdown itself bounded rather
than merely make peer progress independent.

## Reviewable acceptance scenarios

Use `scripts/test.sh cli` only, with a fake HOME, real persisted queue, local
fixture adapters, and controlled HTTP responses. Three integration scenarios
cover the meaningful boundaries without one test per state:

- Fail session protocol preparation, keep a queued session, and successfully
  upload a Skill and heartbeat. Restore the session adapter; the retained session
  uploads after backoff without duplicated watchers or a daemon restart.
- Fail a Skill worker while its scan and one drain request are active. Verify
  both leases drain/cancel before replacement, no stale hash/claim acknowledgement
  removes a newer queued version, and healthy session uploads continue. Abort
  during retry/cleanup and assert every owned handle and queue write finishes.
- Return an authoritative 401/disconnect during local retry and during SSE.
  Both slots and observation stop via the existing global authority boundary;
  queued work is retained and exit code stays 2. A partial/aborted inventory never
  authorizes deletion.

Done: these scenarios and existing sync, queue, watcher, session protocol and
Vault isolation tests pass through the hermetic CLI entrypoint, with no live
services or left-over task resources. This design requires review of the
adapter cancellation and lease boundaries before implementation is called done.
