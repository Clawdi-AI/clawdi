import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type RuntimeAppliedStateV2, writeRuntimeAppliedState } from "./applied-state";
import {
	HostedRuntimeHeartbeatSession,
	runtimeHeartbeatObservationStatePath,
} from "./heartbeat-observation";
import { readHostedRuntimeObserved } from "./observed";
import { getRuntimePaths, type RuntimePaths } from "./paths";

const originalEnv = { ...process.env };
const originalDateNow = Date.now;
const originalMathRandom = Math.random;
const roots: string[] = [];

afterEach(() => {
	process.env = { ...originalEnv };
	Date.now = originalDateNow;
	Math.random = originalMathRandom;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRuntimePaths(): RuntimePaths {
	const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-heartbeat-"));
	roots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	return getRuntimePaths({ mode: "hosted" });
}

function legacyAppliedState(generation: number): RuntimeAppliedStateV2 {
	return {
		schemaVersion: "clawdi.runtimeAppliedState.v2",
		appliedAt: `2026-07-16T00:00:0${generation}.000Z`,
		instanceId: "hri_heartbeat",
		etag: `"transport-bundle-${generation}"`,
		sourceRevision: (generation === 8 ? "d" : "c").repeat(64),
		generation,
		contentIdentity: {
			sourcePath: "https://runtime.test/v1/runtime/manifest",
			sha256: (generation === 8 ? "b" : "a").repeat(64),
		},
		providerIds: ["managed"],
		projectedProviderIds: { openclaw: ["managed"] },
	};
}

function companionAppliedState(generation: number): RuntimeAppliedStateV2 {
	return {
		...legacyAppliedState(generation),
		manifestETag: `"frozen-manifest-${generation}"`,
		applyReceiptId: `apply-receipt-000${generation}`,
		bootNonce: `boot-nonce-00000${generation}`,
	};
}

function idSequence(values: string[]): () => string {
	let index = 0;
	return () => {
		const value = values[index];
		if (value === undefined) throw new Error("test ID sequence exhausted");
		index += 1;
		return value;
	};
}

function clockSequence(values: string[]): () => Date {
	let index = 0;
	return () => {
		const value = values[index];
		if (value === undefined) throw new Error("test clock sequence exhausted");
		index += 1;
		return new Date(value);
	};
}

function blockAtomicWrite(path: string): () => void {
	const timestamp = 1_721_177_296_000;
	const random = 0.5;
	Date.now = () => timestamp;
	Math.random = () => random;
	const temporaryPath = join(
		dirname(path),
		`.${basename(path)}.tmp-${process.pid}-${timestamp}-${random.toString(36).slice(2)}`,
	);
	mkdirSync(temporaryPath, { recursive: true });
	return () => {
		Date.now = originalDateNow;
		Math.random = originalMathRandom;
		rmSync(temporaryPath, { recursive: true, force: true });
	};
}

describe("hosted runtime heartbeat observation", () => {
	test("captures one immutable apply identity for the entire boot session", () => {
		const paths = tempRuntimePaths();
		writeRuntimeAppliedState(companionAppliedState(7), paths);
		const session = new HostedRuntimeHeartbeatSession({
			environmentId: "env_heartbeat",
			paths,
			now: clockSequence(["2026-07-16T01:00:00.000Z", "2026-07-16T01:01:00.000Z"]),
			createId: idSequence(["boot-session-0001", "event-0000000001", "event-0000000002"]),
		});
		const statePath = runtimeHeartbeatObservationStatePath(paths, "env_heartbeat");
		const persisted: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
		expect(persisted).toMatchObject({
			bootIdentity: {
				generation: 7,
				manifestETag: '"frozen-manifest-7"',
				applyReceiptId: "apply-receipt-0007",
				bootNonce: "boot-nonce-000007",
				bootSessionId: "boot-session-0001",
			},
		});
		expect(statSync(statePath).mode & 0o777).toBe(0o600);

		const first = session.nextEvent();
		if (!first) throw new Error("expected first companion event");
		expect(first.event).toMatchObject({
			applyReceiptId: "apply-receipt-0007",
			bootNonce: "boot-nonce-000007",
			bootSessionId: "boot-session-0001",
			sequence: 1,
			eventId: "event-0000000001",
			capturedAt: "2026-07-16T01:00:00.000Z",
			reportedAt: "2026-07-16T01:00:00.000Z",
			applied: {
				generation: 7,
				etag: '"frozen-manifest-7"',
			},
		});
		expect(first.event.applied?.etag).not.toBe('"transport-bundle-7"');
		expect(first.payloadJson).toBe(JSON.stringify(first.event));
		expect(first.payloadSha256).toBe(createHash("sha256").update(first.payloadJson).digest("hex"));
		expect(session.acknowledge(first.event.eventId)).toBe(true);

		writeRuntimeAppliedState(companionAppliedState(8), paths);
		const second = session.nextEvent();
		if (!second) throw new Error("expected second companion event");
		expect(second.event).toMatchObject({
			applyReceiptId: "apply-receipt-0007",
			bootNonce: "boot-nonce-000007",
			bootSessionId: "boot-session-0001",
			sequence: 2,
			eventId: "event-0000000002",
			applied: {
				generation: 7,
				etag: '"frozen-manifest-7"',
			},
		});
	});

	test("persists one exact event across retries and restart until acknowledgement", () => {
		const paths = tempRuntimePaths();
		writeRuntimeAppliedState(companionAppliedState(7), paths);
		const firstSession = new HostedRuntimeHeartbeatSession({
			environmentId: "env_retry",
			paths,
			now: clockSequence(["2026-07-16T02:00:00.000Z", "2026-07-16T02:01:00.000Z"]),
			createId: idSequence(["boot-session-0001", "event-0000000001", "event-0000000002"]),
		});
		const first = firstSession.nextEvent();
		if (!first) throw new Error("expected first event");
		expect(firstSession.acknowledge(first.event.eventId)).toBe(true);
		const second = firstSession.nextEvent();
		if (!second) throw new Error("expected second event");
		expect(second.event.sequence).toBe(2);

		const retry = firstSession.nextEvent();
		if (!retry) throw new Error("expected retry event");
		expect(retry).toEqual(second);
		expect(retry.event.capturedAt).toBe("2026-07-16T02:01:00.000Z");
		expect(retry.event.eventId).toBe("event-0000000002");

		const restarted = new HostedRuntimeHeartbeatSession({
			environmentId: "env_retry",
			paths,
			now: clockSequence(["2026-07-16T02:02:00.000Z"]),
			createId: idSequence(["boot-session-0002", "event-0000000003"]),
		});
		const retryAfterRestart = restarted.nextEvent();
		if (!retryAfterRestart) throw new Error("expected retry after restart");
		expect(retryAfterRestart).toEqual(second);
		expect(restarted.acknowledge("different-event-id")).toBe(false);
		expect(restarted.nextEvent()).toEqual(second);
		expect(restarted.acknowledge(second.event.eventId)).toBe(true);

		const nextBootEvent = restarted.nextEvent();
		if (!nextBootEvent) throw new Error("expected new-boot event");
		expect(nextBootEvent.event).toMatchObject({
			bootSessionId: "boot-session-0002",
			sequence: 1,
			eventId: "event-0000000003",
			capturedAt: "2026-07-16T02:02:00.000Z",
		});
	});

	test("does not advance in-memory sequence when buffering fails to persist", () => {
		const paths = tempRuntimePaths();
		writeRuntimeAppliedState(companionAppliedState(7), paths);
		const session = new HostedRuntimeHeartbeatSession({
			environmentId: "env_buffer_write_failure",
			paths,
			now: clockSequence(["2026-07-16T03:00:00.000Z", "2026-07-16T03:01:00.000Z"]),
			createId: idSequence(["boot-session-0001", "failed-event-0001", "persisted-event-0001"]),
		});
		const statePath = runtimeHeartbeatObservationStatePath(paths, "env_buffer_write_failure");
		const unblock = blockAtomicWrite(statePath);
		try {
			expect(() => session.nextEvent()).toThrow();
		} finally {
			unblock();
		}

		const durableAfterFailure: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
		expect(durableAfterFailure).toMatchObject({ nextSequence: 1, pending: null });
		const persisted = session.nextEvent();
		if (!persisted) throw new Error("expected event after durable state recovered");
		expect(persisted.event).toMatchObject({
			sequence: 1,
			eventId: "persisted-event-0001",
			capturedAt: "2026-07-16T03:01:00.000Z",
		});
	});

	test("does not clear the in-memory pending event when acknowledgement fails to persist", () => {
		const paths = tempRuntimePaths();
		writeRuntimeAppliedState(companionAppliedState(7), paths);
		const session = new HostedRuntimeHeartbeatSession({
			environmentId: "env_ack_write_failure",
			paths,
			now: clockSequence(["2026-07-16T04:00:00.000Z"]),
			createId: idSequence(["boot-session-0001", "pending-event-0001"]),
		});
		const pending = session.nextEvent();
		if (!pending) throw new Error("expected pending event");
		const statePath = runtimeHeartbeatObservationStatePath(paths, "env_ack_write_failure");
		const unblock = blockAtomicWrite(statePath);
		try {
			expect(() => session.acknowledge(pending.event.eventId)).toThrow();
			expect(session.nextEvent()).toEqual(pending);
		} finally {
			unblock();
		}

		expect(session.acknowledge(pending.event.eventId)).toBe(true);
		const durableAfterAcknowledgement: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
		expect(durableAfterAcknowledgement).toMatchObject({ nextSequence: 2, pending: null });
	});

	test("keeps legacy hosted observations when the complete apply tuple is unavailable", () => {
		const paths = tempRuntimePaths();
		writeRuntimeAppliedState(legacyAppliedState(7), paths);
		const session = new HostedRuntimeHeartbeatSession({
			environmentId: "env_legacy",
			paths,
			createId: () => {
				throw new Error("legacy heartbeat must not mint companion IDs");
			},
		});

		expect(session.hasCompanionIdentity).toBe(false);
		expect(session.nextEvent()).toBeNull();
		expect(existsSync(runtimeHeartbeatObservationStatePath(paths, "env_legacy"))).toBe(false);
		expect(readHostedRuntimeObserved(paths)?.applied?.etag).toBe('"transport-bundle-7"');
	});

	test("rejects a boot session ID outside the frozen 128-character bound", () => {
		const paths = tempRuntimePaths();
		writeRuntimeAppliedState(companionAppliedState(7), paths);
		expect(
			() =>
				new HostedRuntimeHeartbeatSession({
					environmentId: "env_boot_bound",
					paths,
					createId: () => "b".repeat(129),
				}),
		).toThrow();
	});
});
