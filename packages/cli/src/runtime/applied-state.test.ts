import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	chownSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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
		activated: {
			"openclaw-gateway.service": "d".repeat(64),
		},
		providerIds: ["clawdi-default", "default"],
		projectedProviderIds: {
			hermes: ["clawdi-default"],
			openclaw: ["default"],
		},
		officialServiceCommandRevisions: {
			"openclaw-gateway.service": "b".repeat(64),
		},
	};
}

function releasedAppliedStateFixture(version: "0.13.92" | "0.14.14") {
	return {
		schemaVersion: "clawdi.runtimeAppliedState.v2" as const,
		appliedAt: `2026-07-${version === "0.13.92" ? "13" : "14"}T06:00:00.000Z`,
		instanceId: `hri_${version.replaceAll(".", "_")}`,
		etag: `"release-${version}"`,
		sourceRevision: "c".repeat(64),
		generation: version === "0.13.92" ? 13 : 14,
		contentIdentity: {
			sourcePath: "https://runtime.test/v1/runtime/manifest",
			sha256: "a".repeat(64),
		},
		egressSidecarSecretRevision: "e".repeat(64),
		daemonAuthTokenRevision: "d".repeat(64),
		daemonProgramRevision: "d".repeat(32),
		userProcessRevisionAliases: {
			"openclaw-gateway.service": {
				desiredRevision: "d".repeat(32),
				processRevision: "a".repeat(32),
			},
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
	test("uses a strict v2 schema for private applied authority", () => {
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
		expect(
			runtimeAppliedStateSchema.safeParse({
				...state,
				officialServiceCommandRevisions: { "openclaw-gateway.service": "invalid" },
			}).success,
		).toBe(false);
		expect(
			runtimeAppliedStateSchema.safeParse({
				...state,
				activated: { "openclaw-gateway.service": "invalid" },
			}).success,
		).toBe(false);
	});

	for (const version of ["0.13.92", "0.14.14"] as const) {
		test(`migrates the ${version} released applied-state format`, () => {
			const migrated = runtimeAppliedStateSchema.parse(releasedAppliedStateFixture(version));
			expect(migrated.activated).toEqual({});
			for (const field of [
				"egressSidecarSecretRevision",
				"daemonAuthTokenRevision",
				"daemonProgramRevision",
				"userProcessRevisionAliases",
			]) {
				expect(Object.hasOwn(migrated, field)).toBe(false);
			}
		});
	}

	test("reads old state through the named fallback and preserves explicit apply generation", () => {
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
		const splitGeneration = runtimeAppliedStateSchema.parse({
			...complete,
			generation: 2,
			applyGeneration: 1,
			manifestETag: '"manifest-generation-1"',
			applyReceiptId: "apply-receipt-0001",
			bootNonce: "boot-nonce-000001",
		});
		expect(splitGeneration.generation).toBe(2);
		expect(splitGeneration.applyGeneration).toBe(1);
		expect(runtimeAppliedApplyIdentity(splitGeneration)).toEqual({
			generation: 1,
			manifestETag: '"manifest-generation-1"',
			applyReceiptId: "apply-receipt-0001",
			bootNonce: "boot-nonce-000001",
		});
		const independentlyAdvancedApply = runtimeAppliedStateSchema.parse({
			...complete,
			generation: 2,
			applyGeneration: 3,
			manifestETag: '"manifest-generation-3"',
			applyReceiptId: "apply-receipt-0003",
			bootNonce: "boot-nonce-000003",
		});
		expect(runtimeAppliedApplyIdentity(independentlyAdvancedApply)).toEqual({
			generation: 3,
			manifestETag: '"manifest-generation-3"',
			applyReceiptId: "apply-receipt-0003",
			bootNonce: "boot-nonce-000003",
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
		chmodSync(root, 0o755);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const paths = getRuntimePaths({ mode: "hosted" });
		mkdirSync(paths.serviceStateRoot);
		const state = appliedStateFixture();

		expect(paths.appliedState).toBe(join(root, "state", "status", "runtime-applied.json"));
		expect(writeRuntimeAppliedState(state, paths)).toBe(paths.appliedState);
		expect(readRuntimeAppliedState(paths)).toEqual(state);
		const appliedStat = statSync(paths.appliedState);
		expect(appliedStat.mode & 0o777).toBe(0o600);

		chmodSync(paths.appliedState, 0o644);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			chownSync(paths.appliedState, 65534, 65534);
		}
		expect(readRuntimeAppliedState(paths)).toEqual(state);
		const unchangedStat = statSync(paths.appliedState);
		expect(unchangedStat.mode & 0o777).toBe(0o644);
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			expect(unchangedStat.uid).toBe(65534);
			expect(unchangedStat.gid).toBe(65534);
		}

		writeFileSync(paths.appliedState, "not-json\n");
		expect(readRuntimeAppliedState(paths)).toBeNull();
		writeFileSync(paths.appliedState, `${JSON.stringify({ ...state, futureField: true })}\n`);
		expect(readRuntimeAppliedState(paths)).toBeNull();
	});

	test("hashes canonical JSON content independently of object key order", () => {
		expect(runtimeContentSha256({ a: 1, nested: { b: 2, c: 3 } })).toBe(
			runtimeContentSha256({ nested: { c: 3, b: 2 }, a: 1 }),
		);
	});
});
