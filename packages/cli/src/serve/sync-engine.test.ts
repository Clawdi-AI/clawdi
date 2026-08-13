import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CollectSessionsResult } from "../adapters/base";
import { adapterRegistry } from "../adapters/registry";
import { AgentSkillSyncNotFoundError, ApiClient, ApiError } from "../lib/api-client";
import {
	computeSkillFolderHash,
	readSkillProjectionClaimsForAgent,
	recordProjectSkillMaterialization,
	recordSkillProjectionClaim,
} from "../lib/skills-lock";
import { computeSkillArchiveHash } from "../lib/tar";
import { releaseManagedSkill, reserveManagedSkill } from "../runtime/managed-skill-reservation";
import { RetryQueue } from "./queue";
import {
	classifyHeartbeatFailure,
	connectedProjectSkillDeliveryEnabled,
	enqueueChangedSessionsAfterStability,
	filterValidSkillKeysForSync,
	heartbeatDelayMs,
	isAuthFailure,
	isOversizedUploadError,
	isPermanentUploadError,
	isSafelyTerminalRuntimeObservationFailure,
	isSkillSyncServerEvent,
	lastSyncErrorForSseReconnect,
	processQueueItem,
	projectRefreshDelayMs,
	reconcileAgentSkillProjection,
	reconcileAgentSkillProjectionListing,
	reconcileDelayMs,
	resolveOwningSkillKey,
	runSyncEngine,
	SyncHealth,
	skillInvalidationKey,
	staleSkillProjectionProjectIds,
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

describe("Agent filesystem projection reconcile", () => {
	async function withProjectionCase(
		run: (fixture: {
			root: string;
			queue: RetryQueue;
			keys: Set<string>;
			reconcile: (claims: Map<string, string>, legacy?: ReadonlySet<string>) => Promise<void>;
		}) => Promise<void>,
	): Promise<void> {
		const root = mkdtempSync(join(tmpdir(), "agent-skill-projection-"));
		const originalHome = process.env.HOME;
		const originalState = process.env.CLAWDI_STATE_DIR;
		try {
			process.env.HOME = root;
			process.env.CLAWDI_STATE_DIR = join(root, "serve");
			const skillsRoot = join(root, "skills");
			mkdirSync(skillsRoot, { recursive: true });
			const keys = new Set<string>();
			const queue = new RetryQueue({ agentType: "hermes" });
			await run({
				root: skillsRoot,
				queue,
				keys,
				reconcile: (claims, trustedLegacyRemoteKeys) =>
					reconcileAgentSkillProjection({
						opts: {
							environmentId: "agent-1",
							adapter: {
								agentType: "hermes",
								getSkillsRootDir: () => skillsRoot,
								listSkillKeys: async () => [...keys],
							},
						},
						queue,
						claims,
						projectId: "project-1",
						trustedLegacyRemoteKeys,
					}),
			});
			await queue.flushPersist();
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalState === undefined) delete process.env.CLAWDI_STATE_DIR;
			else process.env.CLAWDI_STATE_DIR = originalState;
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("durably deletes a claimed nested key missing after directory removal", async () => {
		await withProjectionCase(async ({ queue, reconcile }) => {
			await reconcile(new Map([["category/demo", "claimed-hash"]]));
			const item = queue.peek();
			expect(item?.kind).toBe("skill_delete");
			expect(item && "skill_key" in item ? item.skill_key : undefined).toBe("category/demo");
			expect(item && "agent_id" in item ? item.agent_id : undefined).toBe("agent-1");
			expect(item && "project_id" in item ? item.project_id : undefined).toBe("project-1");
		});
	});

	it("retains the delete queue item and claim on a dedicated 404, then releases both on 204", async () => {
		await withProjectionCase(async ({ queue }) => {
			recordSkillProjectionClaim({
				agentType: "hermes",
				agentId: "agent-1",
				projectId: "project-1",
				skillKey: "claimed",
				hash: "claimed-hash",
			});
			queue.enqueue({
				kind: "skill_delete",
				agent_id: "agent-1",
				project_id: "project-1",
				skill_key: "claimed",
				enqueued_at: new Date().toISOString(),
				attempts: 0,
			});
			const item = queue.peek();
			if (item?.kind !== "skill_delete") throw new Error("expected queued delete");

			const originalFetch = globalThis.fetch;
			const requests: Request[] = [];
			let responseStatus = 404;
			try {
				globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					requests.push(input instanceof Request ? input : new Request(input, init));
					return responseStatus === 204
						? new Response(null, { status: 204 })
						: new Response('{"detail":"Agent not found"}', { status: 404 });
				}) as typeof fetch;
				const adapter = adapterRegistry.hermes.create();
				const abortController = new AbortController();
				const opts = {
					environmentId: "agent-1",
					adapter,
					abort: abortController.signal,
					abortController,
				};
				const api = new ApiClient({ requireAuth: false });

				await expect(
					processQueueItem(opts, api, queue, item, new Map(), new Map(), new Map(), "project-1"),
				).rejects.toBeInstanceOf(AgentSkillSyncNotFoundError);
				expect(isPermanentUploadError(new AgentSkillSyncNotFoundError("missing"))).toBe(false);
				expect(queue.peek()?.version).toBe(item.version);
				expect(
					readSkillProjectionClaimsForAgent("hermes", "agent-1").map((claim) => claim.project_id),
				).toEqual(["project-1"]);
				expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
					"/v1/agents/agent-1/skills/sync/claimed",
				]);

				responseStatus = 204;
				await processQueueItem(
					opts,
					api,
					queue,
					item,
					new Map(),
					new Map(),
					new Map(),
					"project-1",
				);
				expect(queue.depth).toBe(0);
				expect(readSkillProjectionClaimsForAgent("hermes", "agent-1")).toEqual([]);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	it("uses only a complete-listing key as migration evidence for an unclaimed legacy row", async () => {
		await withProjectionCase(async ({ queue, reconcile }) => {
			await reconcile(new Map());
			expect(queue.depth).toBe(0);
			await reconcile(new Map(), new Set(["legacy"]));
			expect(queue.peek()?.kind).toBe("skill_delete");
		});
	});

	it("does not queue a skill whose YAML metadata decodes to NUL", async () => {
		await withProjectionCase(async ({ root, queue, keys, reconcile }) => {
			const local = join(root, "decoded-nul");
			mkdirSync(local, { recursive: true });
			const skillMd = '---\nname: "invalid\\0name"\ndescription: metadata\n---\n# Body\n';
			expect(Buffer.from(skillMd).includes(0)).toBe(false);
			writeFileSync(join(local, "SKILL.md"), skillMd);
			keys.add("decoded-nul");

			await reconcile(new Map());
			expect(queue.depth).toBe(0);
		});
	});

	it("treats a current Agent-Project SSE key as an absence or local reproject hint", async () => {
		await withProjectionCase(async ({ root, queue, keys, reconcile }) => {
			await reconcile(new Map(), new Set(["legacy-absent"]));
			expect(queue.peek()?.kind).toBe("skill_delete");

			const local = join(root, "legacy-present");
			mkdirSync(local, { recursive: true });
			writeFileSync(join(local, "SKILL.md"), "# Local remains authoritative\n");
			keys.add("legacy-present");
			await reconcile(new Map(), new Set(["legacy-present"]));
			expect(
				queue.all().find((item) => "skill_key" in item && item.skill_key === "legacy-present")
					?.kind,
			).toBe("skill_push");
			expect(existsSync(join(local, "SKILL.md"))).toBe(true);
		});
	});

	it("never reconciles or drains a Project materialization as agent_sync", async () => {
		await withProjectionCase(async ({ root, queue, keys, reconcile }) => {
			const local = join(root, "shared", "review-pr__alice");
			mkdirSync(local, { recursive: true });
			writeFileSync(join(local, "SKILL.md"), "# Project-owned\n");
			keys.add("shared/review-pr__alice");
			recordProjectSkillMaterialization({
				agentType: "hermes",
				localSkillKey: "shared/review-pr__alice",
				sourceProjectId: "project-shared",
				sourceSkillKey: "review-pr",
				contentHash: "source-hash",
			});

			await reconcile(new Map(), new Set(["shared/review-pr__alice"]));
			expect(queue.depth).toBe(0);
			writeFileSync(join(local, "SKILL.md"), "# Locally edited but still Project-owned\n");
			await reconcile(new Map());
			expect(queue.depth).toBe(0);

			recordSkillProjectionClaim({
				agentType: "hermes",
				agentId: "agent-1",
				projectId: "project-old",
				skillKey: "shared/review-pr__alice",
				hash: "stale-agent-hash",
			});
			await reconcile(new Map());
			const cleanup = queue.peek();
			if (cleanup?.kind !== "skill_delete") throw new Error("expected projection cleanup");
			const cleanupFetch = globalThis.fetch;
			const requests: Request[] = [];
			try {
				globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					requests.push(input instanceof Request ? input : new Request(input, init));
					return new Response(null, { status: 204 });
				}) as typeof fetch;
				const abortController = new AbortController();
				const outcome = await processQueueItem(
					{
						environmentId: "agent-1",
						adapter: adapterRegistry.hermes.create(),
						abort: abortController.signal,
						abortController,
					},
					new ApiClient({ requireAuth: false }),
					queue,
					cleanup,
					new Map(),
					new Map(),
					new Map(),
					"project-1",
				);
				expect(outcome).toBe("applied");
				expect(new URL(requests[0]?.url ?? "http://invalid").searchParams.get("project_id")).toBe(
					"project-old",
				);
				expect(readSkillProjectionClaimsForAgent("hermes", "agent-1")).toEqual([]);
				expect(existsSync(join(local, "SKILL.md"))).toBe(true);
			} finally {
				globalThis.fetch = cleanupFetch;
			}

			queue.enqueue({
				kind: "skill_push",
				agent_id: "agent-1",
				project_id: "project-1",
				skill_key: "shared/review-pr__alice",
				new_hash: "queued-before-fence",
				enqueued_at: new Date().toISOString(),
				attempts: 0,
			});
			const queued = queue.peek();
			if (!queued) throw new Error("expected queued Skill push");
			let requestCount = 0;
			const originalFetch = globalThis.fetch;
			try {
				globalThis.fetch = Object.assign(
					async () => {
						requestCount++;
						return new Response("unexpected", { status: 500 });
					},
					{ preconnect: originalFetch.preconnect },
				);
				const abortController = new AbortController();
				const outcome = await processQueueItem(
					{
						environmentId: "agent-1",
						adapter: adapterRegistry.hermes.create(),
						abort: abortController.signal,
						abortController,
					},
					new ApiClient({ requireAuth: false }),
					queue,
					queued,
					new Map(),
					new Map(),
					new Map(),
					"project-1",
				);
				expect(outcome).toBe("absent");
				expect(queue.depth).toBe(0);
				expect(requestCount).toBe(0);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	it("reserved handoff deletes the old projection without touching the managed target", async () => {
		await withProjectionCase(async ({ root, queue, keys, reconcile }) => {
			const target = join(root, "managed");
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "SKILL.md"), "# Managed\n");
			keys.add("managed");
			reserveManagedSkill({
				targetDir: target,
				id: "managed",
				version: 1,
				digest: "a".repeat(64),
				manager: "local-setup",
			});
			recordSkillProjectionClaim({
				agentType: "hermes",
				agentId: "agent-1",
				projectId: "project-old",
				skillKey: "managed",
				hash: "user-hash",
			});
			await reconcile(new Map());
			expect(queue.peek()?.kind).toBe("skill_delete");
			expect(existsSync(join(target, "SKILL.md"))).toBe(true);
		});
	});

	it("reservation rollback replaces its pending delete with the unchanged user push", async () => {
		await withProjectionCase(async ({ root, queue, keys, reconcile }) => {
			const target = join(root, "demo");
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "SKILL.md"), "# User\n");
			keys.add("demo");
			const hash = await computeSkillFolderHash(target);
			reserveManagedSkill({
				targetDir: target,
				id: "demo",
				version: 1,
				digest: "a".repeat(64),
				manager: "local-setup",
			});
			await reconcile(new Map([["demo", hash]]));
			expect(queue.peek()?.kind).toBe("skill_delete");
			releaseManagedSkill({
				targetDir: target,
				id: "demo",
				manager: "local-setup",
				removeTarget: () => undefined,
			});
			await reconcile(new Map([["demo", hash]]));
			expect(queue.peek()?.kind).toBe("skill_push");
		});
	});

	it("retains old-Project cleanup identity across reassignment", async () => {
		await withProjectionCase(async () => {
			recordSkillProjectionClaim({
				agentType: "hermes",
				agentId: "agent-1",
				projectId: "project-old",
				skillKey: "demo",
				hash: "old-hash",
			});
			expect(staleSkillProjectionProjectIds("hermes", "agent-1", "demo", "project-new")).toEqual([
				"project-old",
			]);
			expect(
				staleSkillProjectionProjectIds("hermes", "different-agent", "demo", "project-new"),
			).toEqual([]);
		});
	});

	it("enqueues old-Project exact claims after restart when local content is absent", async () => {
		await withProjectionCase(async ({ queue, reconcile }) => {
			recordSkillProjectionClaim({
				agentType: "hermes",
				agentId: "agent-1",
				projectId: "project-old",
				skillKey: "gone",
				hash: "old-hash",
			});
			await reconcile(new Map());
			expect(queue.peek()?.kind).toBe("skill_delete");
			await queue.flushPersist();
			const restarted = new RetryQueue({ agentType: "hermes" });
			restarted.load();
			const pending = restarted.peek();
			expect(pending?.kind).toBe("skill_delete");
			expect(pending && "project_id" in pending ? pending.project_id : undefined).toBe("project-1");
		});
	});

	it("cleans every stale Project before projecting current bytes and retries partial cleanup", async () => {
		await withProjectionCase(async ({ root, queue, keys, reconcile }) => {
			const originalHermesHome = process.env.HERMES_HOME;
			const originalFetch = globalThis.fetch;
			try {
				process.env.HERMES_HOME = dirname(root);
				const local = join(root, "demo");
				mkdirSync(local, { recursive: true });
				writeFileSync(join(local, "SKILL.md"), "# Current\n");
				keys.add("demo");
				for (const projectId of ["project-old-a", "project-old-b"]) {
					recordSkillProjectionClaim({
						agentType: "hermes",
						agentId: "agent-1",
						projectId,
						skillKey: "demo",
						hash: `hash-${projectId}`,
					});
				}
				await reconcile(new Map());
				const item = queue.peek();
				if (!item) throw new Error("expected queued Skill projection");

				let failSecondOldProject = true;
				const calls: string[] = [];
				globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const request = input instanceof Request ? input : new Request(input, init);
					const url = new URL(request.url);
					if (request.method === "DELETE") {
						const projectId = url.searchParams.get("project_id") ?? "missing";
						calls.push(`delete:${projectId}`);
						if (projectId === "project-old-b" && failSecondOldProject) {
							return new Response("offline", { status: 503 });
						}
						return new Response(null, { status: 204 });
					}
					if (request.method === "POST") {
						calls.push("upload:project-1");
						return new Response(JSON.stringify({ version: 1 }), {
							headers: { "content-type": "application/json" },
						});
					}
					return new Response("unexpected", { status: 404 });
				}) as typeof fetch;

				const adapter = adapterRegistry.hermes.create();
				const abortController = new AbortController();
				const opts = {
					environmentId: "agent-1",
					adapter,
					abort: abortController.signal,
					abortController,
				};
				const api = new ApiClient({ requireAuth: false });
				await expect(
					processQueueItem(opts, api, queue, item, new Map(), new Map(), new Map(), "project-1"),
				).rejects.toThrow(/503/);
				expect(calls).not.toContain("upload:project-1");
				expect(
					readSkillProjectionClaimsForAgent("hermes", "agent-1").map((claim) => claim.project_id),
				).toEqual(["project-old-b"]);

				failSecondOldProject = false;
				const retryItem = queue.peek();
				if (!retryItem) throw new Error("expected retained queue item");
				await processQueueItem(
					opts,
					api,
					queue,
					retryItem,
					new Map(),
					new Map(),
					new Map(),
					"project-1",
				);
				expect(calls.at(-2)).toBe("delete:project-old-b");
				expect(calls.at(-1)).toBe("upload:project-1");
				expect(
					readSkillProjectionClaimsForAgent("hermes", "agent-1").map((claim) => claim.project_id),
				).toEqual(["project-1"]);
			} finally {
				globalThis.fetch = originalFetch;
				if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
				else process.env.HERMES_HOME = originalHermesHome;
			}
		});
	});

	it("uploads a symlink projection with the hash of the exact dereferenced archive", async () => {
		await withProjectionCase(async ({ root, queue, keys, reconcile }) => {
			const originalHermesHome = process.env.HERMES_HOME;
			const originalFetch = globalThis.fetch;
			try {
				process.env.HERMES_HOME = dirname(root);
				const shared = join(root, "shared");
				mkdirSync(shared, { recursive: true });
				writeFileSync(join(shared, "body.md"), "shared body\n");
				const local = join(root, "demo");
				mkdirSync(local, { recursive: true });
				writeFileSync(join(local, "SKILL.md"), "# Demo\n");
				symlinkSync(join(shared, "body.md"), join(local, "body.md"));
				keys.add("demo");
				await reconcile(new Map());
				const item = queue.peek();
				if (!item) throw new Error("expected queued projection");

				let verifiedHash: string | null = null;
				globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const request = input instanceof Request ? input : new Request(input, init);
					const form = await request.formData();
					const archive = form.get("file");
					const suppliedHash = form.get("content_hash");
					if (!(archive instanceof Blob) || typeof suppliedHash !== "string") {
						return new Response("invalid multipart", { status: 400 });
					}
					verifiedHash = await computeSkillArchiveHash(
						Buffer.from(await archive.arrayBuffer()),
						"demo",
					);
					expect(suppliedHash).toBe(verifiedHash);
					return new Response(JSON.stringify({ version: 1 }), {
						headers: { "content-type": "application/json" },
					});
				}) as typeof fetch;

				const adapter = adapterRegistry.hermes.create();
				const abortController = new AbortController();
				await processQueueItem(
					{
						environmentId: "agent-1",
						adapter,
						abort: abortController.signal,
						abortController,
					},
					new ApiClient({ requireAuth: false }),
					queue,
					item,
					new Map(),
					new Map(),
					new Map(),
					"project-1",
				);
				expect(verifiedHash).not.toBeNull();
			} finally {
				globalThis.fetch = originalFetch;
				if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
				else process.env.HERMES_HOME = originalHermesHome;
			}
		});
	});

	it("re-derives missed alias absence after eviction and restart at the same revision", async () => {
		await withProjectionCase(async ({ root, keys }) => {
			const originalFetch = globalThis.fetch;
			let queue = new RetryQueue({ agentType: "hermes", maxItems: 1 });
			let revision = 7;
			let includeRevision = true;
			let remoteKeys = ["legacy-absent"];
			try {
				globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const request = input instanceof Request ? input : new Request(input, init);
					const etag = `"${revision}:project-1"`;
					if (includeRevision && request.headers.get("if-none-match") === etag) {
						return new Response(null, { status: 304, headers: { etag } });
					}
					return new Response(
						JSON.stringify({
							items: remoteKeys.map((skillKey) => ({ skill_key: skillKey, name: skillKey })),
							total: remoteKeys.length,
						}),
						{
							headers: {
								"content-type": "application/json",
								...(includeRevision ? { etag } : {}),
							},
						},
					);
				}) as typeof fetch;
				const api = new ApiClient({ requireAuth: false });
				const opts = {
					environmentId: "agent-1",
					adapter: {
						agentType: "hermes" as const,
						getSkillsRootDir: () => root,
						listSkillKeys: async () => [...keys],
					},
				};

				const same = await reconcileAgentSkillProjectionListing({
					api,
					opts,
					queue,
					claims: new Map(),
					projectId: "project-1",
					previousEtag: '"7:project-1"',
				});
				expect(same).toEqual({
					complete: true,
					changed: false,
					revision: 7,
					etag: '"7:project-1"',
				});
				expect(queue.depth).toBe(0);

				revision = 8;
				const missedAbsent = await reconcileAgentSkillProjectionListing({
					api,
					opts,
					queue,
					claims: new Map(),
					projectId: "project-1",
					previousEtag: '"7:project-1"',
				});
				expect(missedAbsent.changed).toBe(true);
				const absenceDelete = queue.peek();
				expect(absenceDelete?.kind).toBe("skill_delete");
				await reconcileAgentSkillProjectionListing({
					api,
					opts,
					queue,
					claims: new Map(),
					projectId: "project-1",
					previousEtag: '"8:project-1"',
					forceComplete: true,
				});
				expect(queue.peek()?.version).toBe(absenceDelete?.version);

				// A full offline queue may evict the Skill operation. Once the
				// unrelated session completes and the daemon restarts, the durable
				// queue is empty while the remote revision remains unchanged.
				const sessionVersion = queue.enqueue({
					kind: "session_push",
					local_session_id: "session-1",
					content_hash: "session-hash",
					enqueued_at: new Date().toISOString(),
					attempts: 0,
				});
				expect(queue.peek()?.kind).toBe("session_push");
				const sessionItem = queue.peek();
				if (!sessionItem || sessionItem.version !== sessionVersion) {
					throw new Error("expected retained session queue item");
				}
				queue.markDoneIfVersion(sessionItem);
				await queue.flushPersist();
				const restarted = new RetryQueue({ agentType: "hermes", maxItems: 1 });
				restarted.load();
				expect(restarted.depth).toBe(0);
				queue = restarted;
				const replayed = await reconcileAgentSkillProjectionListing({
					api,
					opts,
					queue,
					claims: new Map(),
					projectId: "project-1",
					previousEtag: '"8:project-1"',
					forceComplete: true,
				});
				expect(replayed).toEqual({
					complete: true,
					changed: false,
					revision: 8,
					etag: '"8:project-1"',
				});
				expect(queue.peek()?.kind).toBe("skill_delete");

				const local = join(root, "legacy-present");
				mkdirSync(local, { recursive: true });
				writeFileSync(join(local, "SKILL.md"), "# Never overwritten by listing bytes\n");
				keys.add("legacy-present");
				remoteKeys = ["legacy-present"];
				revision = 9;
				await reconcileAgentSkillProjectionListing({
					api,
					opts,
					queue,
					claims: new Map(),
					projectId: "project-1",
					previousEtag: '"8:project-1"',
				});
				expect(
					queue.all().find((item) => "skill_key" in item && item.skill_key === "legacy-present")
						?.kind,
				).toBe("skill_push");
				expect(readFileSync(join(local, "SKILL.md"), "utf-8")).toContain("Never overwritten");

				includeRevision = false;
				remoteKeys = ["unfenced"];
				const unfenced = await reconcileAgentSkillProjectionListing({
					api,
					opts,
					queue,
					claims: new Map(),
					projectId: "project-1",
					previousEtag: '"9:project-1"',
				});
				expect(unfenced.complete).toBe(false);
				expect(
					queue.all().some((item) => "skill_key" in item && item.skill_key === "unfenced"),
				).toBe(false);
				await queue.flushPersist();
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	it("rejects mixed-ETag pagination as legacy deletion evidence", async () => {
		await withProjectionCase(async ({ queue }) => {
			const originalFetch = globalThis.fetch;
			try {
				globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const request = input instanceof Request ? input : new Request(input, init);
					const page = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "1", 10);
					const itemCount = page === 1 ? 200 : 1;
					const items = Array.from({ length: itemCount }, (_, index) => {
						const skillKey = page === 1 ? `legacy-${index}` : "legacy-final";
						return { skill_key: skillKey, name: skillKey };
					});
					return new Response(JSON.stringify({ items, total: 201 }), {
						headers: {
							"content-type": "application/json",
							etag: page === 1 ? '"11:project-1:a"' : '"11:project-1:b"',
						},
					});
				}) as typeof fetch;

				const result = await reconcileAgentSkillProjectionListing({
					api: new ApiClient({ requireAuth: false }),
					opts: {
						environmentId: "agent-1",
						adapter: {
							agentType: "hermes",
							getSkillsRootDir: () => "/unused",
							listSkillKeys: async () => [],
						},
					},
					queue,
					claims: new Map(),
					projectId: "project-1",
					previousEtag: null,
				});
				expect(result.complete).toBe(false);
				expect(queue.depth).toBe(0);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});

	it.each([
		{
			name: "an empty page before the advertised total",
			pages: [{ items: [], total: 1 }],
		},
		{
			name: "a short page before the advertised total",
			pages: [{ items: [{ skill_key: "legacy-short", name: "legacy-short" }], total: 2 }],
		},
		{
			name: "duplicate Skill keys",
			pages: [
				{
					items: [
						{ skill_key: "legacy-duplicate", name: "legacy-duplicate" },
						{ skill_key: "legacy-duplicate", name: "legacy-duplicate" },
					],
					total: 2,
				},
			],
		},
		{
			name: "a total that changes between pages",
			pages: [
				{
					items: Array.from({ length: 200 }, (_, index) => ({
						skill_key: `legacy-total-${index}`,
						name: `legacy-total-${index}`,
					})),
					total: 201,
				},
				{
					items: [{ skill_key: "legacy-total-final", name: "legacy-total-final" }],
					total: 202,
				},
			],
		},
	])("rejects $name as complete legacy deletion evidence", async ({ pages }) => {
		await withProjectionCase(async ({ queue }) => {
			const originalFetch = globalThis.fetch;
			try {
				globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
					const request = input instanceof Request ? input : new Request(input, init);
					const page = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "1", 10);
					const payload = pages[page - 1] ?? { items: [], total: pages[0]?.total ?? 0 };
					return new Response(JSON.stringify(payload), {
						headers: { "content-type": "application/json", etag: '"12:project-1"' },
					});
				}) as typeof fetch;

				const result = await reconcileAgentSkillProjectionListing({
					api: new ApiClient({ requireAuth: false }),
					opts: {
						environmentId: "agent-1",
						adapter: {
							agentType: "hermes",
							getSkillsRootDir: () => "/unused",
							listSkillKeys: async () => [],
						},
					},
					queue,
					claims: new Map(),
					projectId: "project-1",
					previousEtag: null,
				});
				expect(result.complete).toBe(false);
				expect(queue.depth).toBe(0);
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
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

	it("turns legacy and Agent projection events into local re-scan keys only", () => {
		for (const type of [
			"skill_changed",
			"skill_deleted",
			"agent_skill_changed",
			"agent_skill_deleted",
		] as const) {
			expect(
				skillInvalidationKey(
					{
						type,
						project_id: "project-1",
						skill_key: "demo",
						skills_revision: 2,
						...(type.endsWith("changed") ? { content_hash: "projection-hash" } : {}),
					},
					"project-1",
				),
			).toBe("demo");
		}
		expect(
			skillInvalidationKey(
				{
					type: "skill_deleted",
					project_id: "other-project",
					skill_key: "demo",
					skills_revision: 3,
				},
				"project-1",
			),
		).toBeNull();
	});
});

describe("isAuthFailure", () => {
	// Listing and projection paths both rely on this classifier to decide
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

describe("daemon startup Agent lookup", () => {
	async function withStartupCase(
		fetchImpl: (request: Request) => Promise<Response>,
		run: (fixture: {
			abortController: AbortController;
			requests: Request[];
			logs: string[];
		}) => Promise<void>,
	): Promise<void> {
		const root = mkdtempSync(join(tmpdir(), "clawdi-daemon-startup-"));
		const originalFetch = globalThis.fetch;
		const originalStderrWrite = process.stderr.write;
		const originalHome = process.env.CLAWDI_HOME;
		const originalState = process.env.CLAWDI_STATE_DIR;
		const originalApiUrl = process.env.CLAWDI_API_URL;
		const originalAuthToken = process.env.CLAWDI_AUTH_TOKEN;
		const originalAuthOrigin = process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
		const originalExitCode = process.exitCode;
		const requests: Request[] = [];
		const logs: string[] = [];
		try {
			process.env.CLAWDI_HOME = join(root, "home");
			process.env.CLAWDI_STATE_DIR = join(root, "serve");
			process.env.CLAWDI_API_URL = "https://cloud.example.test";
			process.env.CLAWDI_AUTH_TOKEN = "clawdi_test_token";
			process.env.CLAWDI_AUTH_TOKEN_ORIGIN = "https://cloud.example.test";
			process.exitCode = 0;
			globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
				const request = input instanceof Request ? input : new Request(input, init);
				requests.push(request);
				return fetchImpl(request);
			}) as typeof fetch;
			process.stderr.write = ((chunk: string | Uint8Array) => {
				logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
				return true;
			}) as typeof process.stderr.write;
			await run({ abortController: new AbortController(), requests, logs });
		} finally {
			globalThis.fetch = originalFetch;
			process.stderr.write = originalStderrWrite;
			if (originalHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = originalHome;
			if (originalState === undefined) delete process.env.CLAWDI_STATE_DIR;
			else process.env.CLAWDI_STATE_DIR = originalState;
			if (originalApiUrl === undefined) delete process.env.CLAWDI_API_URL;
			else process.env.CLAWDI_API_URL = originalApiUrl;
			if (originalAuthToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = originalAuthToken;
			if (originalAuthOrigin === undefined) delete process.env.CLAWDI_AUTH_TOKEN_ORIGIN;
			else process.env.CLAWDI_AUTH_TOKEN_ORIGIN = originalAuthOrigin;
			process.exitCode = originalExitCode ?? 0;
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("maps the stable archived-Agent 403 to disconnected guidance and a no-restart stop", async () => {
		await withStartupCase(
			async () =>
				new Response('{"detail":{"code":"agent_disconnected","message":"Agent is disconnected"}}', {
					status: 403,
					headers: { "content-type": "application/json" },
				}),
			async ({ abortController, requests, logs }) => {
				await runSyncEngine({
					environmentId: "agent-disconnected",
					adapter: adapterRegistry.hermes.create(),
					abort: abortController.signal,
					abortController,
					forcePollWatcher: true,
				});

				expect(requests).toHaveLength(1);
				expect(new URL(requests[0].url).pathname).toBe("/v1/agents/agent-disconnected");
				expect(process.exitCode).toBe(2);
				expect(abortController.signal.aborted).toBe(true);
				expect(logs.join("")).toContain('"level":"info","event":"engine.agent_disconnected"');
				expect(logs.join("")).toContain("This installation is disconnected");
				expect(logs.join("")).toContain("retained data");
				expect(logs.join("")).not.toContain('"event":"engine.auth_failed"');
			},
		);
	});

	it("keeps an ambiguous 404 on a safe legacy-compatible stop path", async () => {
		await withStartupCase(
			async () => new Response('{"detail":"Agent not found"}', { status: 404 }),
			async ({ abortController, requests, logs }) => {
				await runSyncEngine({
					environmentId: "agent-disconnected",
					adapter: adapterRegistry.hermes.create(),
					abort: abortController.signal,
					abortController,
					forcePollWatcher: true,
				});

				expect(requests).toHaveLength(1);
				expect(new URL(requests[0].url).pathname).toBe("/v1/agents/agent-disconnected");
				expect(process.exitCode).toBe(2);
				expect(abortController.signal.aborted).toBe(true);
				expect(logs.join("")).toContain('"level":"info","event":"engine.agent_disconnected"');
				expect(logs.join("")).toContain("Agent was not found");
				expect(logs.join("")).not.toContain("retained data");
				expect(logs.join("")).not.toContain('"level":"error","event":"engine.agent_disconnected"');
			},
		);
	});

	it("keeps an unrelated 403 on the established auth-failure stop path", async () => {
		await withStartupCase(
			async () =>
				new Response('{"detail":"Forbidden"}', {
					status: 403,
					headers: { "content-type": "application/json" },
				}),
			async ({ abortController, logs }) => {
				await runSyncEngine({
					environmentId: "agent-forbidden",
					adapter: adapterRegistry.hermes.create(),
					abort: abortController.signal,
					abortController,
					forcePollWatcher: true,
				});

				expect(process.exitCode).toBe(2);
				expect(abortController.signal.aborted).toBe(true);
				expect(logs.join("")).toContain('"level":"error","event":"engine.auth_failed"');
				expect(logs.join("")).not.toContain('"event":"engine.agent_disconnected"');
			},
		);
	});

	it("keeps server failures on the ordinary retry and fatal path", async () => {
		await withStartupCase(
			async () => new Response("offline", { status: 503 }),
			async ({ abortController, requests }) => {
				await expect(
					runSyncEngine({
						environmentId: "agent-offline",
						adapter: adapterRegistry.hermes.create(),
						abort: abortController.signal,
						abortController,
						forcePollWatcher: true,
					}),
				).rejects.toThrow(/503/);

				expect(requests).toHaveLength(3);
				expect(
					requests.every((request) => new URL(request.url).pathname === "/v1/agents/agent-offline"),
				).toBe(true);
				expect(process.exitCode).toBe(0);
				expect(abortController.signal.aborted).toBe(false);
			},
		);
	});

	it("keeps network failures on the ordinary retry and fatal path", async () => {
		await withStartupCase(
			async () => {
				throw new TypeError("fetch failed");
			},
			async ({ abortController, requests }) => {
				await expect(
					runSyncEngine({
						environmentId: "agent-network-offline",
						adapter: adapterRegistry.hermes.create(),
						abort: abortController.signal,
						abortController,
						forcePollWatcher: true,
					}),
				).rejects.toMatchObject({ status: 0, isNetwork: true });

				expect(requests).toHaveLength(3);
				expect(process.exitCode).toBe(0);
				expect(abortController.signal.aborted).toBe(false);
			},
		);
	});
});

describe("live-sync transient failure classification", () => {
	it("keeps unrelated unresolved errors after transport and resource successes", () => {
		const health = new SyncHealth();
		health.set("projection", "skill:broken", "skill projection evidence: disk busy");
		health.set("transport", "sse", "sse_disconnect:http_502");
		health.set("push", "session:healthy", "session upload failed");
		health.set("transport", "auth", "auth_revoked: rejected");

		expect(health.project()).toBe("auth_revoked: rejected");
		health.clear("transport", "auth");

		health.clear("transport", "sse");
		expect(health.project()).toBe("skill projection evidence: disk busy");

		health.clear("push", "session:healthy");
		expect(health.project()).toBe("skill projection evidence: disk busy");

		health.clear("projection", "skill:broken");
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
	it("renews the Connected capability lease inside its ten-minute freshness window", () => {
		expect(reconcileDelayMs(() => 0)).toBe(240_000);
		expect(reconcileDelayMs(() => 0.5)).toBe(300_000);
		expect(reconcileDelayMs(() => 1)).toBe(360_000);
		expect(reconcileDelayMs(() => 1)).toBeLessThan(10 * 60_000);
	});

	it("keeps Legacy V1 and Hosted V2 deployments off the Connected lease path", () => {
		expect(connectedProjectSkillDeliveryEnabled("hosted")).toBe(false);
		expect(connectedProjectSkillDeliveryEnabled(" HOSTED ")).toBe(false);
		expect(connectedProjectSkillDeliveryEnabled("local")).toBe(true);
		expect(connectedProjectSkillDeliveryEnabled(undefined)).toBe(true);
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
