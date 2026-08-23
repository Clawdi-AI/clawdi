import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { components } from "@clawdi/shared/api";
import { type RuntimeAppliedStateV2, writeRuntimeAppliedState } from "./applied-state";
import { HostedRuntimeHeartbeatSession } from "./heartbeat-observation";
import {
	HostedRuntimeObservationProducer,
	isPermanentRuntimeObservationRejection,
	runRuntimeObservationProducer,
} from "./observation-producer";
import { getRuntimePaths, type RuntimePaths } from "./paths";

const originalEnv = { ...process.env };
const roots: string[] = [];

afterEach(() => {
	process.env = { ...originalEnv };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRuntimePaths(): RuntimePaths {
	const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-producer-"));
	roots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	process.env.CLAWDI_ENVIRONMENT_ID = "env_producer";
	const paths = getRuntimePaths({ mode: "hosted" });
	mkdirSync(paths.serviceStateRoot);
	return paths;
}

function appliedState(generation: number): RuntimeAppliedStateV2 {
	const sourceRevision = (generation === 1 ? "a" : "b").repeat(64);
	return {
		schemaVersion: "clawdi.runtimeAppliedState.v2",
		appliedAt: `2026-07-22T00:00:0${generation}.000Z`,
		instanceId: "hri_producer",
		etag: `"sha256:${sourceRevision}"`,
		sourceRevision,
		generation,
		manifestETag: `"manifest-${generation}"`,
		applyReceiptId: `apply-receipt-000${generation}`,
		bootNonce: "boot-nonce-000001",
		contentIdentity: {
			sourcePath: "https://runtime.test/v1/runtime/manifest",
			sha256: (generation === 1 ? "c" : "d").repeat(64),
		},
		providerIds: [],
		projectedProviderIds: {},
	};
}

function runtimeContextPath(paths: RuntimePaths): string {
	return join(paths.runRoot, "secrets", "runtime-context.json");
}

function writeApplyIdentityFile(paths: RuntimePaths, generation: number): void {
	const path = runtimeContextPath(paths);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			schemaVersion: "clawdi.runtimeContext.v3",
			backend: "incus",
			apply: {
				generation,
				manifestETag: `"manifest-${generation}"`,
				applyReceiptId: `apply-receipt-000${generation}`,
				bootNonce: "boot-nonce-000001",
			},
			manifestSource: {
				type: "http",
				url: "https://runtime.test/v1/runtime/manifest?environment_id=env_producer",
				auth: { type: "bearer", token: "runtime-auth-token" },
			},
		}),
	);
}

function writeObservationHealth(paths: RuntimePaths, status: "ok" | "error"): void {
	for (const path of [paths.runtimeWatchStatus, paths.manifestLastGood]) {
		mkdirSync(dirname(path), { recursive: true });
	}
	writeFileSync(paths.runtimeWatchStatus, JSON.stringify({ event: { status: "applied" } }));
	writeFileSync(
		paths.manifestLastGood,
		JSON.stringify({
			projection: {
				providers: {
					default: { status, baseUrl: "https://api.test/v1", model: "test-model" },
				},
			},
		}),
	);
}

async function observationSchedule(
	initialStatus: "ok" | "error",
	stopAtMs: number,
	transitionToOk = false,
): Promise<Array<{ at: number; status: "ok" | "error" | "unknown" }>> {
	const paths = tempRuntimePaths();
	writeApplyIdentityFile(paths, 1);
	writeRuntimeAppliedState(appliedState(1), paths);
	writeObservationHealth(paths, initialStatus);
	const abort = new AbortController();
	const attempts: Array<{ at: number; status: "ok" | "error" | "unknown" }> = [];
	let clock = 0;

	await runRuntimeObservationProducer({
		abort: abort.signal,
		paths,
		contextPath: runtimeContextPath(paths),
		submit: async (_environmentId, event) => {
			attempts.push({ at: clock, status: event.status });
			return "accepted";
		},
		now: () => clock,
		delay: async (ms) => {
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			clock += ms;
			if (transitionToOk && attempts.length === 1) writeObservationHealth(paths, "ok");
			if (clock >= stopAtMs) abort.abort();
		},
	});

	return attempts;
}

describe("hosted runtime observation producer", () => {
	test("accepts apply generation three at checkpoint two and submits its exact identity", async () => {
		const paths = tempRuntimePaths();
		writeApplyIdentityFile(paths, 3);
		writeRuntimeAppliedState(
			{
				...appliedState(3),
				generation: 2,
				applyGeneration: 3,
			},
			paths,
		);
		let submitted: components["schemas"]["RuntimeObservationEventV2"] | null = null;
		const producer = new HostedRuntimeObservationProducer({
			abort: new AbortController().signal,
			paths,
			contextPath: runtimeContextPath(paths),
			submit: async (environmentId, event) => {
				expect(environmentId).toBe("env_producer");
				submitted = event;
				return "accepted";
			},
			sessionFactory: (environmentId, sessionPaths) =>
				new HostedRuntimeHeartbeatSession({
					environmentId,
					paths: sessionPaths,
					createId: () => "event-or-boot-identity",
					now: () => new Date("2026-07-22T00:01:00.000Z"),
				}),
		});

		expect(await producer.sendOnce()).toEqual({ outcome: "accepted", status: "unknown" });
		expect(submitted).toMatchObject({
			generation: 3,
			manifestETag: '"manifest-3"',
			bootSessionId: "event-or-boot-identity",
			sequence: 1,
			eventId: "event-or-boot-identity",
			applyReceiptId: "apply-receipt-0003",
			bootNonce: "boot-nonce-000001",
			applied: {
				generation: 3,
				etag: `"sha256:${"b".repeat(64)}"`,
				sourceRevision: "b".repeat(64),
			},
		});
	});

	test("re-reads the projected tuple after rotation and preserves the workload boot nonce", async () => {
		const paths = tempRuntimePaths();
		writeApplyIdentityFile(paths, 1);
		writeRuntimeAppliedState(appliedState(1), paths);
		const ids = [
			"boot-000000000001",
			"event-00000000001",
			"boot-000000000002",
			"event-00000000002",
		];
		const times = [new Date("2026-07-22T00:01:00.000Z"), new Date("2026-07-22T00:02:00.000Z")];
		const events: components["schemas"]["RuntimeObservationEventV2"][] = [];
		const producer = new HostedRuntimeObservationProducer({
			abort: new AbortController().signal,
			paths,
			contextPath: runtimeContextPath(paths),
			submit: async (environmentId, event) => {
				expect(environmentId).toBe("env_producer");
				events.push(event);
				return "accepted";
			},
			sessionFactory: (environmentId, sessionPaths) =>
				new HostedRuntimeHeartbeatSession({
					environmentId,
					paths: sessionPaths,
					createId: () => {
						const id = ids.shift();
						if (!id) throw new Error("test ID sequence exhausted");
						return id;
					},
					now: () => {
						const time = times.shift();
						if (!time) throw new Error("test clock sequence exhausted");
						return time;
					},
				}),
		});

		expect(await producer.sendOnce()).toEqual({ outcome: "accepted", status: "unknown" });
		writeApplyIdentityFile(paths, 2);
		writeRuntimeAppliedState(appliedState(2), paths);
		expect(await producer.sendOnce()).toEqual({ outcome: "accepted", status: "unknown" });

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			generation: 1,
			manifestETag: '"manifest-1"',
			bootSessionId: "boot-000000000001",
			sequence: 1,
			eventId: "event-00000000001",
			applyReceiptId: "apply-receipt-0001",
			bootNonce: "boot-nonce-000001",
			applied: { generation: 1, etag: `"sha256:${"a".repeat(64)}"` },
		});
		expect(events[1]).toMatchObject({
			generation: 2,
			manifestETag: '"manifest-2"',
			bootSessionId: "boot-000000000002",
			sequence: 1,
			eventId: "event-00000000002",
			applyReceiptId: "apply-receipt-0002",
			bootNonce: "boot-nonce-000001",
			applied: { generation: 2, etag: `"sha256:${"b".repeat(64)}"` },
		});
	});

	test("stays idle when no successfully applied tuple exists", async () => {
		const paths = tempRuntimePaths();
		writeApplyIdentityFile(paths, 1);
		let submits = 0;
		const producer = new HostedRuntimeObservationProducer({
			abort: new AbortController().signal,
			paths,
			contextPath: runtimeContextPath(paths),
			submit: async () => {
				submits += 1;
				return "accepted";
			},
		});

		expect(await producer.sendOnce()).toEqual({ outcome: "idle" });
		expect(submits).toBe(0);
	});

	test("does not attest a durable tuple that differs from the process environment", async () => {
		const paths = tempRuntimePaths();
		writeApplyIdentityFile(paths, 2);
		writeRuntimeAppliedState(appliedState(1), paths);
		let submits = 0;
		const producer = new HostedRuntimeObservationProducer({
			abort: new AbortController().signal,
			paths,
			contextPath: runtimeContextPath(paths),
			submit: async () => {
				submits += 1;
				return "accepted";
			},
		});

		expect(await producer.sendOnce()).toEqual({ outcome: "idle" });
		expect(submits).toBe(0);
	});

	test("does not submit diagnostics with an invalid runtime bundle validator", async () => {
		const paths = tempRuntimePaths();
		writeApplyIdentityFile(paths, 1);
		writeRuntimeAppliedState({ ...appliedState(1), etag: `"sha256:${"f".repeat(64)}"` }, paths);
		let submits = 0;
		const producer = new HostedRuntimeObservationProducer({
			abort: new AbortController().signal,
			paths,
			contextPath: runtimeContextPath(paths),
			submit: async () => {
				submits += 1;
				return "accepted";
			},
		});

		expect(await producer.sendOnce()).toEqual({ outcome: "failed" });
		expect(submits).toBe(0);
	});

	test("drops a failed old-tuple pending event when the applied tuple rotates", async () => {
		const paths = tempRuntimePaths();
		writeApplyIdentityFile(paths, 1);
		writeRuntimeAppliedState(appliedState(1), paths);
		const ids = ["boot-000000000001", "old-event-000001", "boot-000000000002", "new-event-000001"];
		const submitted: components["schemas"]["RuntimeObservationEventV2"][] = [];
		const producer = new HostedRuntimeObservationProducer({
			abort: new AbortController().signal,
			paths,
			contextPath: runtimeContextPath(paths),
			submit: async (_environmentId, event) => {
				submitted.push(event);
				if (submitted.length === 1) throw new Error("temporary old-tuple failure");
				return "accepted";
			},
			sessionFactory: (environmentId, sessionPaths) =>
				new HostedRuntimeHeartbeatSession({
					environmentId,
					paths: sessionPaths,
					createId: () => {
						const id = ids.shift();
						if (!id) throw new Error("test ID sequence exhausted");
						return id;
					},
					now: () => new Date("2026-07-22T00:03:00.000Z"),
				}),
		});

		expect(await producer.sendOnce()).toEqual({ outcome: "failed" });
		writeApplyIdentityFile(paths, 2);
		writeRuntimeAppliedState(appliedState(2), paths);
		expect(await producer.sendOnce()).toEqual({ outcome: "accepted", status: "unknown" });

		expect(submitted.map((event) => event.eventId)).toEqual([
			"old-event-000001",
			"new-event-000001",
		]);
		expect(submitted[1]).toMatchObject({
			bootSessionId: "boot-000000000002",
			sequence: 1,
			applied: { generation: 2 },
		});
	});

	test("retires a permanently rejected event and captures a fresh observation", async () => {
		const paths = tempRuntimePaths();
		writeApplyIdentityFile(paths, 1);
		writeRuntimeAppliedState(appliedState(1), paths);
		const submitted: components["schemas"]["RuntimeObservationEventV2"][] = [];
		const ids = ["boot-session-0001", "rejected-event-0001", "fresh-event-000002"];
		const times = [new Date("2026-07-22T00:01:00.000Z"), new Date("2026-07-22T00:02:00.000Z")];
		const producer = new HostedRuntimeObservationProducer({
			abort: new AbortController().signal,
			paths,
			contextPath: runtimeContextPath(paths),
			submit: async (_environmentId, event) => {
				submitted.push(event);
				return submitted.length === 1 ? "terminal-rejected" : "accepted";
			},
			sessionFactory: (environmentId, sessionPaths) =>
				new HostedRuntimeHeartbeatSession({
					environmentId,
					paths: sessionPaths,
					createId: () => {
						const id = ids.shift();
						if (!id) throw new Error("test ID sequence exhausted");
						return id;
					},
					now: () => {
						const time = times.shift();
						if (!time) throw new Error("test clock sequence exhausted");
						return time;
					},
				}),
		});

		expect(await producer.sendOnce()).toEqual({ outcome: "sent" });
		expect(await producer.sendOnce()).toEqual({ outcome: "accepted", status: "unknown" });
		expect(submitted.map((event) => event.eventId)).toEqual([
			"rejected-event-0001",
			"fresh-event-000002",
		]);
		expect(submitted[1]?.sequence).toBe(2);
	});

	test("does not let an unresolved old-tuple request block rotation", async () => {
		const paths = tempRuntimePaths();
		writeApplyIdentityFile(paths, 1);
		writeRuntimeAppliedState(appliedState(1), paths);
		const abort = new AbortController();
		const submitted: components["schemas"]["RuntimeObservationEventV2"][] = [];
		let resolveOld: ((result: "accepted") => void) | null = null;
		let delayCalls = 0;

		await runRuntimeObservationProducer({
			abort: abort.signal,
			paths,
			contextPath: runtimeContextPath(paths),
			submit: async (_environmentId, event) => {
				submitted.push(event);
				if (event.applied.generation === 1) {
					return await new Promise<"accepted">((resolve) => {
						resolveOld = resolve;
					});
				}
				resolveOld?.("accepted");
				return "accepted";
			},
			delay: async () => {
				delayCalls += 1;
				if (delayCalls === 1) {
					writeApplyIdentityFile(paths, 2);
					writeRuntimeAppliedState(appliedState(2), paths);
					return;
				}
				if (submitted.some((event) => event.applied.generation === 2)) {
					await Promise.resolve();
					abort.abort();
				}
			},
		});

		expect(submitted.map((event) => event.applied.generation)).toEqual([1, 2]);
		expect(submitted[1]).toMatchObject({ sequence: 1, applied: { generation: 2 } });
	});

	test("forgets retired identity schedules and in-flight attempts", async () => {
		const paths = tempRuntimePaths();
		writeApplyIdentityFile(paths, 1);
		writeRuntimeAppliedState(appliedState(1), paths);
		const abort = new AbortController();
		const submitted: number[] = [];
		let firstGenerationOneResolve: ((result: "accepted") => void) | null = null;
		let generationOneAttempts = 0;
		let delayCalls = 0;
		let clock = 0;

		await runRuntimeObservationProducer({
			abort: abort.signal,
			paths,
			contextPath: runtimeContextPath(paths),
			submit: async (_environmentId, event) => {
				submitted.push(event.applied.generation);
				if (event.applied.generation !== 1) return "accepted";
				generationOneAttempts += 1;
				if (generationOneAttempts === 1) {
					return await new Promise<"accepted">((resolve) => {
						firstGenerationOneResolve = resolve;
					});
				}
				return await new Promise<"accepted">(() => {});
			},
			now: () => clock,
			delay: async (ms) => {
				delayCalls += 1;
				clock += ms;
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				if (delayCalls === 1) {
					writeApplyIdentityFile(paths, 2);
					writeRuntimeAppliedState(appliedState(2), paths);
					firstGenerationOneResolve?.("accepted");
					await Promise.resolve();
					await Promise.resolve();
				} else if (delayCalls === 2 || delayCalls === 4) {
					writeApplyIdentityFile(paths, 1);
					writeRuntimeAppliedState(appliedState(1), paths);
				} else if (delayCalls === 3) {
					writeApplyIdentityFile(paths, 2);
					writeRuntimeAppliedState(appliedState(2), paths);
				} else if (generationOneAttempts === 3 || delayCalls >= 8) {
					abort.abort();
				}
			},
		});

		expect(submitted).toEqual([1, 2, 1, 2, 1]);
	});

	test.each([
		[400, true],
		[401, true],
		[403, true],
		[404, true],
		[409, true],
		[422, true],
		[429, false],
		[500, false],
	] as const)("classifies HTTP %i permanent rejection as %s", (status, expected) => {
		expect(isPermanentRuntimeObservationRejection({ response: { status } })).toBe(expected);
	});

	test("reports a non-ok to ok transition within five seconds", async () => {
		expect(await observationSchedule("error", 6_000, true)).toEqual([
			{ at: 0, status: "error" },
			{ at: 5_000, status: "ok" },
		]);
	});

	test.each([
		[
			"bounds non-ok fast observations to ninety seconds",
			"error",
			151_000,
			[...Array.from({ length: 19 }, (_, index) => index * 5_000), 150_000],
		],
		["keeps ready observations on the steady cadence", "ok", 61_000, [0, 60_000]],
	] as const)("%s", async (_name, status, stopAtMs, expectedTimes) => {
		const attempts = await observationSchedule(status, stopAtMs);
		expect(attempts.map((attempt) => attempt.at)).toEqual([...expectedTimes]);
		expect(attempts.every((attempt) => attempt.status === status)).toBe(true);
	});
});
