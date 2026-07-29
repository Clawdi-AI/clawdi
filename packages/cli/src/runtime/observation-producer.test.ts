import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { components } from "@clawdi/shared/api";
import { type RuntimeAppliedStateV2, writeRuntimeAppliedState } from "./applied-state";
import { HostedRuntimeHeartbeatSession } from "./heartbeat-observation";
import {
	HostedRuntimeObservationProducer,
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
	return getRuntimePaths({ mode: "hosted" });
}

function appliedState(generation: number): RuntimeAppliedStateV2 {
	return {
		schemaVersion: "clawdi.runtimeAppliedState.v2",
		appliedAt: `2026-07-22T00:00:0${generation}.000Z`,
		instanceId: "hri_producer",
		etag: `"transport-${generation}"`,
		sourceRevision: (generation === 1 ? "a" : "b").repeat(64),
		generation,
		manifestETag: `"manifest-${generation}"`,
		applyReceiptId: `apply-receipt-000${generation}`,
		bootNonce: `boot-nonce-00000${generation}`,
		contentIdentity: {
			sourcePath: "https://runtime.test/v1/runtime/manifest",
			sha256: (generation === 1 ? "c" : "d").repeat(64),
		},
		providerIds: [],
		projectedProviderIds: {},
	};
}

function setApplyIdentityEnvironment(generation: number): void {
	process.env.CLAWDI_RUNTIME_GENERATION = String(generation);
	process.env.CLAWDI_RUNTIME_MANIFEST_ETAG = `"manifest-${generation}"`;
	process.env.CLAWDI_RUNTIME_APPLY_RECEIPT_ID = `apply-receipt-000${generation}`;
	process.env.CLAWDI_RUNTIME_BOOT_NONCE = `boot-nonce-00000${generation}`;
}

function writeObservationHealth(paths: RuntimePaths, status: "ok" | "error"): void {
	for (const path of [paths.runtimeWatchStatus, paths.providerHealthStatus]) {
		mkdirSync(dirname(path), { recursive: true });
	}
	writeFileSync(paths.runtimeWatchStatus, JSON.stringify({ event: { status: "applied" } }));
	writeFileSync(paths.providerHealthStatus, JSON.stringify({ providers: { default: { status } } }));
}

describe("hosted runtime observation producer", () => {
	test("re-reads the applied tuple after rotation and emits a new boot identity", async () => {
		const paths = tempRuntimePaths();
		setApplyIdentityEnvironment(1);
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
		setApplyIdentityEnvironment(2);
		writeRuntimeAppliedState(appliedState(2), paths);
		expect(await producer.sendOnce()).toEqual({ outcome: "accepted", status: "unknown" });

		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({
			bootSessionId: "boot-000000000001",
			sequence: 1,
			eventId: "event-00000000001",
			applyReceiptId: "apply-receipt-0001",
			bootNonce: "boot-nonce-000001",
			applied: { generation: 1, etag: '"manifest-1"' },
		});
		expect(events[1]).toMatchObject({
			bootSessionId: "boot-000000000002",
			sequence: 1,
			eventId: "event-00000000002",
			applyReceiptId: "apply-receipt-0002",
			bootNonce: "boot-nonce-000002",
			applied: { generation: 2, etag: '"manifest-2"' },
		});
	});

	test("stays idle when no successfully applied tuple exists", async () => {
		const paths = tempRuntimePaths();
		let submits = 0;
		const producer = new HostedRuntimeObservationProducer({
			abort: new AbortController().signal,
			paths,
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
		setApplyIdentityEnvironment(2);
		writeRuntimeAppliedState(appliedState(1), paths);
		let submits = 0;
		const producer = new HostedRuntimeObservationProducer({
			abort: new AbortController().signal,
			paths,
			submit: async () => {
				submits += 1;
				return "accepted";
			},
		});

		expect(await producer.sendOnce()).toEqual({ outcome: "idle" });
		expect(submits).toBe(0);
	});

	test("drops a failed old-tuple pending event when the applied tuple rotates", async () => {
		const paths = tempRuntimePaths();
		setApplyIdentityEnvironment(1);
		writeRuntimeAppliedState(appliedState(1), paths);
		const ids = ["boot-000000000001", "old-event-000001", "boot-000000000002", "new-event-000001"];
		const submitted: components["schemas"]["RuntimeObservationEventV2"][] = [];
		const producer = new HostedRuntimeObservationProducer({
			abort: new AbortController().signal,
			paths,
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
		setApplyIdentityEnvironment(2);
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

	test("does not let an unresolved old-tuple request block rotation", async () => {
		const paths = tempRuntimePaths();
		setApplyIdentityEnvironment(1);
		writeRuntimeAppliedState(appliedState(1), paths);
		const abort = new AbortController();
		const submitted: components["schemas"]["RuntimeObservationEventV2"][] = [];
		let resolveOld: ((result: "accepted") => void) | null = null;
		let delayCalls = 0;

		await runRuntimeObservationProducer({
			abort: abort.signal,
			paths,
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
					setApplyIdentityEnvironment(2);
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

	test("reports a non-ok to ok transition within five seconds", async () => {
		const paths = tempRuntimePaths();
		setApplyIdentityEnvironment(1);
		writeRuntimeAppliedState(appliedState(1), paths);
		writeObservationHealth(paths, "error");
		const abort = new AbortController();
		const attempts: Array<{ at: number; status: "ok" | "error" | "unknown" }> = [];
		let clock = 0;

		await runRuntimeObservationProducer({
			abort: abort.signal,
			paths,
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
				if (attempts.length === 1) writeObservationHealth(paths, "ok");
				if (attempts.length === 2) abort.abort();
				if (clock > 10_000) throw new Error("ready transition observation did not arrive");
			},
		});

		expect(attempts).toEqual([
			{ at: 0, status: "error" },
			{ at: 5_000, status: "ok" },
		]);
	});

	test("bounds fast non-ok observations to the ninety-second convergence window", async () => {
		const paths = tempRuntimePaths();
		setApplyIdentityEnvironment(1);
		writeRuntimeAppliedState(appliedState(1), paths);
		writeObservationHealth(paths, "error");
		const abort = new AbortController();
		const attemptTimes: number[] = [];
		let clock = 0;

		await runRuntimeObservationProducer({
			abort: abort.signal,
			paths,
			submit: async (_environmentId, event) => {
				expect(event.status).toBe("error");
				attemptTimes.push(clock);
				return "accepted";
			},
			now: () => clock,
			delay: async (ms) => {
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				clock += ms;
				if (clock >= 151_000) abort.abort();
			},
		});

		expect(attemptTimes).toEqual([
			...Array.from({ length: 19 }, (_, index) => index * 5_000),
			150_000,
		]);
	});

	test("keeps a ready steady state on the sixty-second cadence", async () => {
		const paths = tempRuntimePaths();
		setApplyIdentityEnvironment(1);
		writeRuntimeAppliedState(appliedState(1), paths);
		writeObservationHealth(paths, "ok");
		const abort = new AbortController();
		const attemptTimes: number[] = [];
		let clock = 0;

		await runRuntimeObservationProducer({
			abort: abort.signal,
			paths,
			submit: async (_environmentId, event) => {
				expect(event.status).toBe("ok");
				attemptTimes.push(clock);
				return "accepted";
			},
			now: () => clock,
			delay: async (ms) => {
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				clock += ms;
				if (attemptTimes.length === 2) abort.abort();
			},
		});

		expect(attemptTimes).toEqual([0, 60_000]);
	});

	test.each([
		"failure",
		"terminal-stale",
	] as const)("does not busy-retry a %s ready-transition observation", async (outcome) => {
		const paths = tempRuntimePaths();
		setApplyIdentityEnvironment(1);
		writeRuntimeAppliedState(appliedState(1), paths);
		writeObservationHealth(paths, "error");
		const abort = new AbortController();
		const attempts: Array<{ at: number; status: "ok" | "error" | "unknown" }> = [];
		let clock = 0;

		await runRuntimeObservationProducer({
			abort: abort.signal,
			paths,
			submit: async (_environmentId, event) => {
				attempts.push({ at: clock, status: event.status });
				if (attempts.length === 2) {
					if (outcome === "failure") throw new Error("temporary ready observation failure");
					return "terminal-stale";
				}
				return "accepted";
			},
			now: () => clock,
			delay: async (ms) => {
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				clock += ms;
				if (attempts.length === 1) writeObservationHealth(paths, "ok");
				if (attempts.length === 3) abort.abort();
			},
		});

		expect(attempts).toEqual([
			{ at: 0, status: "error" },
			{ at: 5_000, status: "ok" },
			{ at: 65_000, status: "ok" },
		]);
	});
});
