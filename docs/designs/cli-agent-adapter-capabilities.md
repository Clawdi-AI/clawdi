# CLI Adapter Modules And Session Events

| Field | Value |
| --- | --- |
| Status | Implemented |
| Last updated | 2026-08-26 |
| Owner | CLI and Session sync |

> HISTORICAL - this document replaces the former mandatory-Session PR-A plan.
> Pi is now the first real session-only adapter, so the deferred module split is complete.

## Adapter Contract

An adapter has core identity plus at least one complete data module:

```ts
type AgentAdapter = AgentAdapterCore &
	AtLeastOne<{
		sessions: SessionModule;
		skills: SkillModule;
	}>;
```

Every method inside a present module is required. There are no method-level
capability flags, no no-op implementations, and no string capability table.
MCP registration is an optional registry lifecycle with both `register` and
`unregister`; it is not a data module.

Claude Code, Codex, Hermes, and OpenClaw expose Sessions and Skills. Pi exposes
Sessions only. The sync engine narrows modules once, starts only their producers,
and shares one API client, heartbeat, health state, supervisor, persisted queue,
and queue drain. A queue item for a missing module or an old unfenced Session
item is dropped fail-closed at that single drain boundary.

Foreground commands, setup/teardown, doctor, inbox, help, Skill SSE and
reconciliation, and Connected dashboard routes gate on real modules. Cloud
Session pull does not require a local Sessions module. Project Skills, Vaults,
Memories, Connectors, Channels, Hosted runtimes, and Agent Plugins are outside
this adapter contract.

## Pi Driver

Pi reads the official JSONL store under `$PI_CODING_AGENT_DIR/sessions` or
`~/.pi/agent/sessions`. It supports v1-v4 records, follows the active parent
leaf, applies compaction retained-tail semantics, ignores a partial final line,
and re-reads the current backing store when a queued item drains. Path scans
fall back to a complete scan when their containment cannot be proven.

Pi uploads namespaced identities (`pi.<session-id>`), visible messages, tool
calls/results, attachment metadata/references, visible custom messages, and
compaction/branch summaries. Provider thinking content and signatures are never
uploaded. Pi is Connected-only: it is not a Hosted runtime, plugin, channel,
control-plane, or deployment type.

## Session Content Protocols

`snapshot-v1` remains readable and writable for old clients and servers. A
Sessions module resolves its local protocol from the current backing store
before server negotiation. Hermes capability-detects `messages` with
`PRAGMA table_info`: stores with a stable `INTEGER PRIMARY KEY id` and the
modern semantic columns use `events-v1`; legacy stores remain on `snapshot-v1`
rather than claiming event fidelity. A new CLI probes
`/v1/sessions/upload-capabilities`; a 404 selects `snapshot-v1`, so an old
server never receives an events envelope.

`events-v1` is strict and private. It contains only continuous, source-identified
`Message`, `ToolCall`, and `ToolResult` events. Message content is text or
an `AttachmentRef` with stable identity and `external` or `metadata_only`
availability. Only safe HTTPS references and opaque provider references carry a
URI. Inline bytes become hash/size metadata, local paths expose at most a
basename, and no attachment body is stored by this version. The schema forbids
extra fields. Hidden chain of thought, encrypted continuation state, and
redacted thinking are excluded at the adapter boundary.

Hermes events follow `messages.id` insertion order and retain every durable
row, including compacted copies and rewound inactive rows. Normalized lifecycle,
compressed-summary, display-kind, and safe presentation metadata let a later
projection reproduce Hermes' active/display/audit views without discarding the
complete store. Dedicated reasoning columns, provider API envelopes, and Codex
reasoning/message carrier fields are never selected.

Codex `AgentMessage` records are emitted only when their persisted content is
entirely plaintext. Because events-v1 has no author/recipient fields, the
visible author-to-recipient context is downgraded into an explicit developer
message prefix; any record containing encrypted content is omitted. Tool-search
calls/results and image-generation results map to the strict tool events, with
generated image bytes reduced to attachment metadata.

Events are stored as immutable NDJSON chunks, normally 1-4 MiB and never over
8 MiB. Each Session has a generation, revision, event count, and chained
canonical head hash. Append sends only new chunks and never reads or rewrites
old objects. It carries a durable `append_id` plus generation and base/final
revision, count, and head fences. A retry with the same result is idempotent;
any other base mismatch returns 409. Truncation or rewrite stages a new
generation and commits it with compare-and-swap.

`/events` is an authenticated private rich read. `/content`, public shares,
exports, and memory consumers project only visible user/assistant text. System,
developer, and tool material never crosses those public-safe surfaces.

## Identity And Persistence

Cloud Session uniqueness includes immutable `origin_environment_id`; the legacy
`environment_id` wire name remains. Snapshot object keys also include this
origin. Deletion suppressions are origin-fenced; legacy suppressions without an
origin remain wildcard-readable.

`queue.jsonl` keeps its released format. New Session items and lock entries are
fenced by canonical API origin, environment id, adapter, and source Session key.
Old files remain readable, but old unfenced items are not applied. Upload success
is recorded only after the server-returned stored hash or event receipt exactly
matches the expected value.

Legacy snapshots over 50 MiB and individual events over the negotiated 8 MiB
limit enter durable blocked health instead of retrying every five minutes.

## Verification

```bash
bun run --cwd packages/cli test -- src/adapters/pi.test.ts src/lib/session-upload.test.ts src/serve/sync-engine.test.ts
cd backend && uv run pytest -q tests/test_session_events.py tests/test_session_deletion.py tests/test_sessions.py
```

Done: both commands run in the repository's isolated test runner and exit zero.
