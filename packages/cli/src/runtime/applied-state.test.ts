import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readRuntimeAppliedState,
	runtimeAppliedApplyIdentity,
	runtimeAppliedStateSchema,
	runtimeContentSha256,
	writeRuntimeAppliedState,
} from "./applied-state";
import { getRuntimePaths } from "./paths";

const originalEnv = { ...process.env };
const roots: string[] = [];

function appliedStateFixture() {
	return {
		schemaVersion: "clawdi.runtimeAppliedState.v2" as const,
		appliedAt: "2026-07-13T06:00:00.000Z",
		instanceId: "hri_applied_state",
		etag: '"bundle-generation-7"',
		sourceRevision: "c".repeat(64),
		generation: 7,
		contentIdentity: {
			sourcePath: "https://runtime.test/v1/runtime/manifest",
			sha256: "a".repeat(64),
		},
		providerIds: ["clawdi-default", "default"],
		projectedProviderIds: {
			hermes: ["clawdi-default"],
			openclaw: ["default"],
		},
	};
}

afterEach(() => {
	process.env = { ...originalEnv };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime applied state", () => {
	test("uses a strict v2 schema with one applied authority", () => {
		const state = appliedStateFixture();
		expect(runtimeAppliedStateSchema.safeParse(state).success).toBe(true);
		expect(runtimeAppliedStateSchema.safeParse({ ...state, unexpected: true }).success).toBe(false);
		expect(
			runtimeAppliedStateSchema.safeParse({ ...state, providerIds: ["default", "default"] })
				.success,
		).toBe(false);
		expect(
			runtimeAppliedStateSchema.safeParse({
				...state,
				contentIdentity: { ...state.contentIdentity, etag: '"legacy"' },
			}).success,
		).toBe(false);
		expect(
			runtimeAppliedStateSchema.safeParse({
				...state,
				projectedProviderIds: { openclaw: ["default", "default"] },
			}).success,
		).toBe(false);
	});

	test("accepts the frozen apply identity only as a complete bounded tuple", () => {
		const state = appliedStateFixture();
		const complete = {
			...state,
			manifestETag: '"manifest-generation-7"',
			applyReceiptId: "apply-receipt-0007",
			bootNonce: "boot-nonce-000007",
		};
		expect(runtimeAppliedStateSchema.safeParse(complete).success).toBe(true);
		expect(runtimeAppliedApplyIdentity(runtimeAppliedStateSchema.parse(complete))).toEqual({
			generation: 7,
			manifestETag: '"manifest-generation-7"',
			applyReceiptId: "apply-receipt-0007",
			bootNonce: "boot-nonce-000007",
		});
		expect(runtimeAppliedApplyIdentity(runtimeAppliedStateSchema.parse(state))).toBeNull();
		expect(
			runtimeAppliedStateSchema.safeParse({
				...state,
				manifestETag: '"manifest-generation-7"',
			}).success,
		).toBe(false);
		expect(
			runtimeAppliedStateSchema.safeParse({
				...complete,
				applyReceiptId: "too-short",
			}).success,
		).toBe(false);
		expect(runtimeAppliedStateSchema.safeParse({ ...complete, generation: 0 }).success).toBe(false);
		expect(
			runtimeAppliedStateSchema.safeParse({ ...complete, manifestETag: "m".repeat(129) }).success,
		).toBe(false);
		expect(
			runtimeAppliedStateSchema.safeParse({ ...complete, bootNonce: "n".repeat(129) }).success,
		).toBe(false);
	});

	test("round-trips atomically under the durable service state root", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-applied-state-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const paths = getRuntimePaths({ mode: "hosted" });
		const state = appliedStateFixture();

		expect(paths.appliedState).toBe(join(root, "state", "status", "runtime-applied.json"));
		expect(writeRuntimeAppliedState(state, paths)).toBe(paths.appliedState);
		expect(readRuntimeAppliedState(paths)).toEqual(state);
		expect(JSON.parse(readFileSync(paths.appliedState, "utf-8"))).toEqual(state);
		expect(statSync(paths.appliedState).mode & 0o777).toBe(0o644);
	});

	test("hashes canonical JSON content independently of object key order", () => {
		expect(runtimeContentSha256({ a: 1, nested: { b: 2, c: 3 } })).toBe(
			runtimeContentSha256({ nested: { c: 3, b: 2 }, a: 1 }),
		);
	});
});
