# CLI Agent Adapters: Mandatory Session Contract Cleanup

| Field | Value |
| --- | --- |
| Status | PR-A implemented in Clawdi CLI 0.13.106; PR-B deferred |
| Last updated | 2026-08-20 |
| Owner | CLI sync layer |
| Prerequisite | [PR #1109](https://github.com/Clawdi-AI/clawdi/pull/1109), including [`8b571e756`](https://github.com/Clawdi-AI/clawdi/commit/8b571e75678b5684d0a300312e8b2718d1bdb687) |

This document defines two deliberately separate adapter changes. PR-A was
implemented in Clawdi CLI 0.13.106 as a behavior-preserving cleanup of the
Session contract introduced by PR #1109. PR-B remains deferred until
immediately before the first real session-only adapter needs `SkillStore`.

Neither PR changes the fact that Session support is mandatory for every
`AgentAdapter`. Do not turn the adapter into a bag of optional capabilities.

## Final Decision

1. PR-A unifies complete and path-targeted Session collection, makes scan
   coverage explicit, makes current-session resolution mandatory, replaces
   watcher flag combinations with a discriminated union, and leaves the sync
   engine with one straight-line Session path.
2. PR-A removes the unused `buildRunCommand` method and centralizes repeated
   path-containment checks in one small helper.
3. PR-A does not extract `SkillStore`, make Skill support nullable, or gate
   Skill workflows. Claude Code, Codex, Hermes, and OpenClaw all have real
   Skill support today, so `skills: null` has no current consumer.
4. `SkillStore` extraction and Skill gating are deferred to PR-B immediately
   before the first confirmed session-only adapter. Its shape must be derived
   from that adapter's verified requirements, not invented in PR-A.
5. Agent Plugins are desired-state and store artifacts delivered through the
   Hosted runtime path. They are not local Session drivers and do not justify
   optional Session methods on `AgentAdapter`.

PR-A followed PR #1109 and included no new adapter.

## PR-A Session Contract

The minimum contract is:

```ts
export type SessionScanRequest =
	| { kind: "complete"; projectFilter?: string }
	| { kind: "paths"; paths: readonly string[]; projectFilter?: string };

export interface SessionScanResult {
	sessions: RawSession[];
	dedupedCount: number;
	coverage: "complete" | "partial";
}

export type SessionWatchEvent =
	| { kind: "rescan" }
	| { kind: "paths"; paths: string[] };

export interface AgentAdapter {
	// Existing identity, detection, version, Skill, and watcher-root methods stay.
	collectSessions(request: SessionScanRequest): Promise<SessionScanResult>;
	resolveSession(localSessionId: string): Promise<RawSession | null>;
}
```

Session methods are required. PR-A kept Skill methods directly on
`AgentAdapter`, required for all four registered adapters.

### Collection And Coverage

- A `complete` request inventories the current source within its optional
  project filter and returns `coverage: "complete"`.
- A `paths` request may return `coverage: "partial"` only when every supplied
  path maps safely to a bounded set of Session records.
- If an adapter cannot answer a `paths` request safely, the adapter performs a
  complete scan itself and returns `coverage: "complete"`.
- A partial result never proves that an omitted Session is absent. Only a
  complete result may clear absent-Session health.
- Claude resume-chain deduplication and Hermes' lack of project filtering stay
  unchanged.

The adapter owns the fallback. The engine must not probe optional methods,
interpret `null` as a request to retry, or maintain a separate mutable
`completeInventory` flag alongside the result.

### Current Session Resolution

`resolveSession(localSessionId)` reads the current backing store and returns the
canonical Session that should be uploaded now.

- It must not return cached transcript content.
- A locator cache may accelerate lookup, but it is not absence authority.
- A missing or stale locator must search the current complete source before
  returning `null`.
- Claude resume-chain predecessors return `null` only after the current chain
  is evaluated.
- The returned Session uses the same parsing and canonicalization as a complete
  scan.

The Codex active-to-archive absence bug is already fixed in PR #1109 commit
`8b571e756`. That commit removes the stale complete-inventory early return and
adds coverage for moving a learned Session from `sessions/` to
`archived_sessions/`. PR-A preserved that behavior and removed only the
residual optional-resolution fallback and completeness plumbing from the
engine. It did not duplicate the fix or its regression test.

### Watcher And Engine Flow

After file-stable debounce, the watcher emits exactly one value:

- `{ kind: "paths", paths }` for concrete, non-empty changed paths;
- `{ kind: "rescan" }` when an event or poll snapshot is ambiguous.

The engine translates that event to one `SessionScanRequest`, calls
`collectSessions` once, hashes and enqueues the returned Sessions, and uses the
result's `coverage` to decide whether absence health may be cleared. Queue drain
always calls mandatory `resolveSession`, recomputes the hash from the returned
current content, and uploads it.

```text
watch event -> scan request -> scan result -> hash and enqueue
queue item -> resolve current Session -> recompute hash -> upload
periodic complete scan -> recover missed work
```

The periodic complete scan remains the recovery layer for missed events,
daemon downtime, late-created roots, dropped queue work, and incomplete watcher
coverage. Filesystem events improve latency; they are not correctness
authority.

Keep the released hash domain byte-for-byte:

```ts
sha256(JSON.stringify(session.messages))
```

### Path Containment And Dead API

The repeated Claude Code, Codex, and OpenClaw containment logic now lives in one
small shared helper. It validates that a resolved candidate path is inside one
of the adapter's declared roots. File extensions, existence checks, storage
layout, and parsing remain adapter-specific.

`buildRunCommand` had no caller and was removed from `AgentAdapter`, all four
implementations, and the tests that only asserted command-prefix construction.
No runner abstraction replaced it.

## Deferred PR-B

PR-B begins only when a concrete session-only adapter is ready. It extracts the
four adapters' existing Skill methods behind an optional `SkillStore` boundary
and gates Skill-specific engine and foreground command paths. Session
collection and resolution remain mandatory.

PR-B must land separately, immediately before the adapter that consumes the
new boundary. The following adapter PR supplies the first session-only consumer
and its behavioral coverage; PR-B must not substitute a fake adapter. Until
then:

- the four registered adapters keep their current Skill behavior;
- the Skill watcher, projection ledgers, queue items, SSE invalidation,
  Connected Project Skill reconciliation, setup, doctor, push, and pull paths
  remain unchanged;
- no `skills: null`, no-op Skill implementation, capability table, or fake
  session-only adapter is introduced.

Agent Plugins remain outside both adapter contracts. Clawdi stores their
catalog and per-Agent desired state, while the Hosted runtime bundle converges
them. They do not read transcript stores, resolve queued Sessions, or run the
self-managed Session watcher.

## Hosted And Connected Boundary

PR-A is internal to the shared CLI Session path and preserves these ownership
boundaries:

| Concern | Required invariant |
| --- | --- |
| Agent identity | Keep the stable Agent id and legacy `environment_id` wire name; do not change origin evidence or principals. |
| Sessions | Hosted and Connected daemons may use the same mandatory adapter Session contract; producing-Agent attribution and runtime credentials remain fenced. |
| Agent Workspace Skills | Keep current adapter filesystem projection in both runtime modes; PR-A adds no capability gate. |
| Project Skills | Keep Connected lease/reconcile separate from Hosted managed-runtime manifest convergence. |
| Agent Plugins | Keep Cloud catalog/desired state and Hosted runtime/store delivery separate from Session adapters. |
| Runtime state | Keep Hosted deployment generations separate from Connected daemon state. |

Do not change principal predicates, `HostedRuntimeState` fences, API-key scopes,
managed-runtime manifests, or Agent identity. See
[`architecture.md`](../architecture.md),
[`runtime.py`](../../backend/app/routes/runtime.py), and
[`skills.py`](../../backend/app/routes/skills.py).

## Frozen Compatibility Surfaces

PR-A is a process-internal refactor. These surfaces stay unchanged:

- CLI commands, flags, output text, JSON output, and exit codes;
- API routes, payloads, response schemas, and existing `agent_type` values;
- Session upload content and hash identity;
- [`queue.jsonl`](../../packages/cli/src/serve/queue.ts) item shapes and version
  compatibility;
- [`sessions-lock.json`](../../packages/cli/src/lib/sessions-lock.ts), Skill
  locks, projection claims, and materialization formats;
- `~/.clawdi/environments/*.json` names and contents;
- Claude resume deduplication, Codex archives, OpenClaw personalities, and
  Hermes project-filter behavior;
- Agent Workspace and Project Skill behavior;
- Hosted/Connected authority, Agent Plugin delivery, and managed-runtime
  contracts.

These persisted formats also serve rolling Hosted runtimes. Do not add a
compatibility migration when no format changes. Follow
[`api-compatibility.md`](../api-compatibility.md) for any separately authorized
wire change.

## PR-A Implementation

1. Added the unified request/result types, explicit coverage, mandatory
   `resolveSession`, and watcher event union while keeping Skill methods in
   place.
2. Adapted all four Session implementations, added the shared containment
   helper, and removed `buildRunCommand`.
3. Changed the watcher to emit `SessionWatchEvent` and the engine to consume one
   request/result path with no optional probes or side completeness flag.
4. Changed queue drain to call `resolveSession` directly while preserving the
   existing hash-before-upload behavior.
5. Removed obsolete fallback plumbing and stale comments without changing
   public behavior, persistence, APIs, Skill workflows, or runtime boundaries.

Done: the PR contains no new adapter, Skill capability split, Agent Plugin
change, wire change, persisted-state migration, or duplicate regression test.

## Verification

PR-A preserved PR #1109's existing coverage for bounded and ambiguous watcher
changes, periodic complete scans, queue-time re-reads, and Codex
active-to-archive resolution. Fixtures changed only as required by the contract
rename. It added no tests for TypeScript declarations, a fake session-only
adapter, or the already-covered Codex move.

```bash
bun run --cwd packages/cli typecheck
bun run --cwd packages/cli test
bunx biome check packages/cli/src packages/cli/tests
git diff --check origin/main...HEAD
```

Done: all commands exit zero and the four current adapters preserve observable
Session and Skill behavior.

## Non-Goals

- making Session support optional or defining a general capability framework;
- extracting or gating Skill storage in PR-A;
- adding a session-only adapter or choosing the order of future adapters;
- changing Agent Plugin catalog, desired state, installation, or delivery;
- message-body search, transcript databases, checkpoints, or content caches;
- a generic parser abstraction or per-tool `RawSession` variants;
- dynamic watcher-root reattachment;
- Hosted manifest, Connected principal, API, or persistence changes;
- new Session archive, delete, resume, or restore commands.
