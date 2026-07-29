import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectSessionsResult } from "../adapters/base";
import { ApiError } from "../lib/api-client";
import type { PendingSkillUploadEcho } from "./sync-engine";
import {
	addInFlight,
	classifyHeartbeatFailure,
	consumePendingSkillUploadEcho,
	enqueueChangedSessionsAfterStability,
	filterValidSkillKeysForSync,
	heartbeatDelayMs,
	isAuthFailure,
	isOversizedUploadError,
	isSafelyTerminalRuntimeObservationFailure,
	isSkillSyncServerEvent,
	lastSyncErrorForSseReconnect,
	projectRefreshDelayMs,
	reconcileDelayMs,
	releaseInFlight,
	rememberPendingSkillUploadEcho,
	resolveOwningSkillKey,
	SyncHealth,
	shouldForceFullSkillListing,
} from "./sync-engine";

describe("stable session enqueue abort fence", () => {
	it("does not enqueue after collection resolves into an abort", async () => {
		const abort = new AbortController();
		let resolveCollection: ((result: CollectSessionsResult) => void) | undefined;
		const collection = new Promise<CollectSessionsResult>((resolve) => {
			resolveCollection = resolve;
		});
		const queued: unknown[] = [];
		const inFlight = new Map<string, string>();
		const running = enqueueChangedSessionsAfterStability({
			abort: abort.signal,
			collectSessions: () => collection,
			queue: { enqueue: (item: unknown) => queued.push(item) },
			lastPushedHash: new Map(),
			inFlightHash: inFlight,
		});

		abort.abort();
		resolveCollection?.({
			sessions: [
				{
					localSessionId: "session-1",
					projectPath: null,
					startedAt: new Date(0),
					endedAt: null,
					messageCount: 1,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					model: null,
					modelsUsed: [],
					durationSeconds: null,
					summary: null,
					messages: [{ role: "user", content: "not queued" }],
					rawFilePath: "/sessions/1.jsonl",
				},
			],
			dedupedCount: 0,
		});

		expect(await running).toBe(0);
		expect(queued).toEqual([]);
		expect(inFlight.size).toBe(0);
	});
});

describe("reserved Skill reconcile listing", () => {
	it("forces a full listing despite a pre-reservation pushed hash", () => {
		const observed = new Set(["managed"]);
		const pushed = new Map([["managed", "old-cloud-hash"]]);
		expect(shouldForceFullSkillListing(observed, pushed, (key) => key === "managed")).toBe(true);
	});

	it("keeps one full pass after release when the deferred hash was cleared", () => {
		const observed = new Set(["managed"]);
		expect(shouldForceFullSkillListing(observed, new Map(), () => false)).toBe(true);
	});
});

describe("daemon SSE routing", () => {
	it("ignores runtime manifest notifications without dispatching skill work", () => {
		expect(
			isSkillSyncServerEvent({
				type: "runtime_manifest_changed",
				environment_id: "env-runtime-1",
			}),
		).toBe(false);
	});
});

describe("isAuthFailure", () => {
	// Pull-side and push-side both rely on this classifier to decide
	// whether to abort the daemon vs. log-and-retry. A wrong answer in
	// either direction is bad: missing a 401 means a revoked key
	// silently loops forever (the bug Codex flagged), and false-
	// positives on a transient 5xx would kill a healthy daemon.
	it.each([401, 403])("treats ApiError(%i) as auth failure", (status) => {
		const e = new ApiError({ status, body: "", hint: "" });
		expect(isAuthFailure(e)).toBe(true);
	});

	it.each([
		400, 404, 408, 429, 500, 502, 503,
	])("does not treat ApiError(%i) as auth failure", (status) => {
		const e = new ApiError({ status, body: "", hint: "" });
		expect(isAuthFailure(e)).toBe(false);
	});

	it("does not treat plain Error as auth failure", () => {
		expect(isAuthFailure(new Error("boom"))).toBe(false);
	});

	it("does not treat network errors (ApiError 0) as auth failure", () => {
		// Network errors normalise to status=0 in the api-client. They
		// must keep retrying — only an explicit 401/403 from the
		// server says the key is rejected.
		const e = new ApiError({ status: 0, body: "", hint: "", isNetwork: true });
		expect(isAuthFailure(e)).toBe(false);
	});

	it("does not treat null/undefined/strings as auth failure", () => {
		expect(isAuthFailure(null)).toBe(false);
		expect(isAuthFailure(undefined)).toBe(false);
		expect(isAuthFailure("401")).toBe(false);
		expect(isAuthFailure({ status: 401 })).toBe(false);
	});
});

describe("live-sync transient failure classification", () => {
	it("keeps unrelated unresolved errors after transport and resource successes", () => {
		const health = new SyncHealth();
		health.set("pull", "skill:broken", "skill broken pull: disk busy");
		health.set("transport", "sse", "sse_disconnect:http_502");
		health.set("push", "session:healthy", "session upload failed");
		health.set("transport", "auth", "auth_revoked: rejected");

		expect(health.project()).toBe("auth_revoked: rejected");
		health.clear("transport", "auth");

		health.clear("transport", "sse");
		expect(health.project()).toBe("skill broken pull: disk busy");

		health.clear("push", "session:healthy");
		expect(health.project()).toBe("skill broken pull: disk busy");

		health.clear("pull", "skill:broken");
		health.set("push", "skill:foo", "permanent: upload rejected");
		health.setIfAbsent("push", "skill:foo", "skill foo push was not applied", true);
		expect(health.project()).toBe("permanent: upload rejected");
		health.set("push", "skill_scan:foo", "skill foo scan failed");
		health.clear("push", "skill_scan:foo");
		expect(health.project()).toBe("permanent: upload rejected");
		health.set("push", "skills_scan", "periodic skills scan failed");
		health.clear("push", "skills_scan");
		expect(health.project()).toBe("permanent: upload rejected");
		health.clear("push", "skill:foo");
		health.setIfAbsent("push", "skill:foo", "skill foo push was not applied", true);
		expect(health.project()).toBe("skill foo push was not applied");
		health.clearTransient("push", "skill:foo");
		health.set("push", "session:deleted", "deleted session failed permanently");
		health.set("push", "session:present", "present session still failing");
		health.clearAbsent("push", "session:", new Set(["session:present"]));
		expect(health.project()).toBe("present session still failing");

		health.clear("push", "session:present");
		expect(health.project()).toBeNull();
	});

	it("does not surface transient SSE reconnects as last_sync_error", () => {
		expect(
			lastSyncErrorForSseReconnect({
				reason: "http_502",
				classification: "transient",
			}),
		).toBeNull();
	});

	it("surfaces sustained SSE reconnects as last_sync_error", () => {
		expect(
			lastSyncErrorForSseReconnect({
				reason: "http_502",
				classification: "sustained",
			}),
		).toBe("sse_disconnect:http_502");
	});

	it("classifies early heartbeat failures as transient and repeated failures as sustained", () => {
		expect(classifyHeartbeatFailure(1)).toBe("transient");
		expect(classifyHeartbeatFailure(3)).toBe("transient");
		expect(classifyHeartbeatFailure(4)).toBe("sustained");
	});

	it("retires only the explicit terminal stale-observation protocol code", () => {
		expect(
			isSafelyTerminalRuntimeObservationFailure({
				response: { status: 422 },
				error: {
					detail: { code: "runtime_observation_captured_at_too_old" },
				},
			}),
		).toBe(true);
		for (const [status, code] of [
			[409, "runtime_observation_identity_conflict"],
			[409, "runtime_observation_event_conflict"],
			[422, "runtime_observation_captured_at_in_future"],
			[422, "runtime_observation_identity_conflict"],
		] as const) {
			expect(
				isSafelyTerminalRuntimeObservationFailure({
					response: { status },
					error: { detail: { code } },
				}),
			).toBe(false);
		}
	});
});

describe("reconcileDelayMs", () => {
	it("keeps cloud reconcile on the safety-net cadence", () => {
		expect(reconcileDelayMs(() => 0)).toBe(240_000);
		expect(reconcileDelayMs(() => 0.5)).toBe(300_000);
		expect(reconcileDelayMs(() => 1)).toBe(360_000);
	});
});

describe("daemon control-plane cadences", () => {
	it("keeps heartbeat jitter inside the dashboard freshness window", () => {
		expect(heartbeatDelayMs(() => 0)).toBe(45_000);
		expect(heartbeatDelayMs(() => 0.5)).toBe(60_000);
		expect(heartbeatDelayMs(() => 1)).toBe(75_000);
	});

	it("keeps project refresh off the heartbeat cadence", () => {
		expect(projectRefreshDelayMs(() => 0)).toBe(240_000);
		expect(projectRefreshDelayMs(() => 0.5)).toBe(300_000);
		expect(projectRefreshDelayMs(() => 1)).toBe(360_000);
	});
});

describe("addInFlight / releaseInFlight refcount", () => {
	// Round-r5 P1: the watcher guard at sync-engine.ts:521 reads
	// `pullsInFlight.has(skillKey)` to short-circuit watcher
	// events fired while writeSkillArchive is rm+extracting (a
	// few-ms window where the dir is empty). Same Map is bumped
	// at the start of `writeSkillArchive` and released in a
	// `finally` — multiple concurrent pulls of the same skill
	// would otherwise have the second `releaseInFlight` clear
	// the entry while the first pull is still extracting,
	// re-opening the watcher echo window. Lock the contract.
	it("has(key) is true between addInFlight and matching releaseInFlight", () => {
		const m = new Map<string, number>();
		addInFlight(m, "foo");
		expect(m.has("foo")).toBe(true);
		releaseInFlight(m, "foo");
		expect(m.has("foo")).toBe(false);
	});

	it("nested addInFlight: has() stays true until the LAST release", () => {
		const m = new Map<string, number>();
		addInFlight(m, "foo");
		addInFlight(m, "foo");
		expect(m.has("foo")).toBe(true);
		releaseInFlight(m, "foo");
		// First release: still in flight (count = 1).
		expect(m.has("foo")).toBe(true);
		releaseInFlight(m, "foo");
		expect(m.has("foo")).toBe(false);
	});

	it("releaseInFlight on missing key is a no-op (does not insert -1 entry)", () => {
		// Defense against an accidental `releaseInFlight` outside
		// a `finally` paired with addInFlight — must not leave a
		// negative-count entry that blocks future watcher events.
		const m = new Map<string, number>();
		releaseInFlight(m, "ghost");
		expect(m.has("ghost")).toBe(false);
	});

	it("entries are independent across keys", () => {
		const m = new Map<string, number>();
		addInFlight(m, "a");
		addInFlight(m, "b");
		expect(m.has("a")).toBe(true);
		expect(m.has("b")).toBe(true);
		releaseInFlight(m, "a");
		expect(m.has("a")).toBe(false);
		expect(m.has("b")).toBe(true);
	});
});

describe("pending skill upload echo suppression", () => {
	it("suppresses the exact skill_changed echo that can arrive before upload returns", () => {
		const pending = new Map<string, PendingSkillUploadEcho>();
		rememberPendingSkillUploadEcho(pending, "foo", "hash-1", 1_000);

		expect(consumePendingSkillUploadEcho(pending, "foo", "hash-1", 1_500)).toBe(true);
		expect(pending.has("foo")).toBe(false);
	});

	it("does not suppress a different hash for the same skill", () => {
		const pending = new Map<string, PendingSkillUploadEcho>();
		rememberPendingSkillUploadEcho(pending, "foo", "hash-1", 1_000);

		expect(consumePendingSkillUploadEcho(pending, "foo", "hash-2", 1_500)).toBe(false);
		expect(pending.has("foo")).toBe(true);
	});

	it("expires stale pending echoes", () => {
		const pending = new Map<string, PendingSkillUploadEcho>();
		rememberPendingSkillUploadEcho(pending, "foo", "hash-1", 1_000);

		expect(consumePendingSkillUploadEcho(pending, "foo", "hash-1", 200_000)).toBe(false);
		expect(pending.has("foo")).toBe(false);
	});
});

describe("resolveOwningSkillKey — dotfile component rejection", () => {
	// Prod observed 728 `engine.queue_drop_permanent` 422 events
	// in the codex daemon log post-#66 deploy. gstack ships its
	// own bundled sub-skills FOR OTHER AGENTS at paths like
	// `~/.codex/skills/gstack/.agents/skills/<sub>/SKILL.md`.
	// fs.watch fires for those, the resolver greedily returned
	// the deepest SKILL.md match, and server's
	// SKILL_KEY_PATTERN rejected with 422 (every component must
	// start with [A-Za-z0-9]).
	//
	// The fix returns null on any path with a dotfile-prefixed
	// component. NOT walk-up to outer skill — that would convert
	// 422s into 413 cascades because the outer `gstack` folder
	// is the 1 GB monster that already trips the 25 MB upload
	// cap. The companion fix in lib/tar.ts excludes those
	// dotfile subtrees from the OUTER skill's tarball so it
	// stays under the cap.

	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "skill-key-resolve-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function makeSkillMd(...segments: string[]) {
		const dir = join(tmp, ...segments);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
	}

	it("returns null when ANY path component starts with a dot (gstack shape)", () => {
		makeSkillMd("gstack");
		makeSkillMd("gstack", ".agents", "skills", "gstack-autoplan");

		// fs.watch fires on the deep nested file; resolver MUST
		// NOT enqueue. Pre-fix this returned
		// `gstack/.agents/skills/gstack-autoplan` and 422'd.
		expect(resolveOwningSkillKey(tmp, "gstack/.agents/skills/gstack-autoplan")).toBeNull();
	});

	it("returns null even when the dotfile is at the leaf (.../foo/.cache/x)", () => {
		makeSkillMd("foo");
		mkdirSync(join(tmp, "foo", ".cache", "x"), { recursive: true });
		expect(resolveOwningSkillKey(tmp, "foo/.cache/x")).toBeNull();
	});

	it("returns the deepest valid skill_key for nested layouts (Hermes)", () => {
		// `category/foo/SKILL.md` exists but no dotfile in path.
		// Resolver returns the deepest match.
		makeSkillMd("category", "foo");
		expect(resolveOwningSkillKey(tmp, "category/foo")).toBe("category/foo");
		expect(resolveOwningSkillKey(tmp, "category/foo/references")).toBe("category/foo");
	});

	it("returns the top-level dir for flat layouts (Claude Code / Codex)", () => {
		makeSkillMd("autoplan");
		expect(resolveOwningSkillKey(tmp, "autoplan")).toBe("autoplan");
		expect(resolveOwningSkillKey(tmp, "autoplan/references/pattern.md")).toBe("autoplan");
	});

	it("returns null for a path with no SKILL.md ancestor", () => {
		expect(resolveOwningSkillKey(tmp, "no-skill-here")).toBeNull();
		expect(resolveOwningSkillKey(tmp, "deep/nested/no-skill")).toBeNull();
	});
});

describe("filterValidSkillKeysForSync", () => {
	it("drops adapter-listed keys the backend would reject", () => {
		expect(
			filterValidSkillKeysForSync(
				["valid-skill", ".system", "category/nested", "category/.cache/sub", "team/download"],
				{ logSkipped: false },
			),
		).toEqual(["valid-skill", "category/nested"]);
	});
});

describe("resolveOwningSkillKey — Windows path separator", () => {
	// Codex flagged: on Windows, watcher.ts builds pathFromRoot
	// via path.join() → backslash-separated. A `/`-only split
	// missed dotfile components like `gstack\.agents\...`,
	// re-enabling the 422 spam this fix is meant to stop. The
	// resolver now splits on both `/` and `\`.
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "skill-key-resolve-win-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("rejects backslash-separated paths with dotfile components", () => {
		// Synthetic Windows-style input. Resolver doesn't actually
		// touch the filesystem for the dotfile check, so we don't
		// need a real backslash-named directory on macOS — the
		// rejection happens before any fs access.
		expect(resolveOwningSkillKey(tmp, "gstack\\.agents\\skills\\gstack-autoplan")).toBeNull();
	});

	it("rejects mixed-separator paths with dotfile components", () => {
		// Windows clients can produce mixed separators (e.g.
		// path.join joining a path that already had `/`).
		expect(resolveOwningSkillKey(tmp, "gstack/.agents\\skills/foo")).toBeNull();
	});
});

describe("isOversizedUploadError", () => {
	// The drain loop branches on this to demote oversize drops from
	// `error` to `warn` (no heartbeat poison). Misclassifying a 400
	// validation error as oversized would silently swallow real bugs.
	it("treats ApiError(413) as oversized", () => {
		expect(isOversizedUploadError(new ApiError({ status: 413, body: "", hint: "" }))).toBe(true);
	});

	it("treats pre-flight 'Skill tarball exceeds' as oversized", () => {
		expect(isOversizedUploadError(new Error("Skill tarball exceeds 26214400 bytes"))).toBe(true);
	});

	it("does not treat other 4xx as oversized", () => {
		for (const status of [400, 404, 422]) {
			expect(isOversizedUploadError(new ApiError({ status, body: "", hint: "" }))).toBe(false);
		}
	});

	it("does not treat unrelated Errors as oversized", () => {
		expect(isOversizedUploadError(new Error("symlink(s) pointing outside"))).toBe(false);
		expect(isOversizedUploadError(new Error("boom"))).toBe(false);
	});
});
