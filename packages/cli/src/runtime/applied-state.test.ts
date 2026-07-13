import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readRuntimeAppliedState,
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
		expect(
			runtimeAppliedStateSchema.safeParse({ ...state, channelsEtag: '"legacy"' }).success,
		).toBe(false);
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

	test("reads legacy v1 state without inventing a source revision", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-runtime-applied-state-legacy-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const paths = getRuntimePaths({ mode: "hosted" });
		mkdirSync(join(root, "state", "status"), { recursive: true });
		writeFileSync(
			paths.appliedState,
			JSON.stringify({
				schemaVersion: "clawdi.runtimeAppliedState.v1",
				appliedAt: "2026-07-13T06:00:00.000Z",
				instanceId: "hri_legacy",
				observedManifestEtag: '"legacy"',
				observedChannelsEtag: null,
				observedConfigGeneration: 6,
				contentIdentity: {
					manifest: {
						source: "remote-datasource",
						sourcePath: "https://runtime.test/v1/runtime/manifest",
						sha256: "a".repeat(64),
					},
					channels: null,
				},
				projectedProviderIds: {},
			}),
		);

		expect(readRuntimeAppliedState(paths)).toMatchObject({
			schemaVersion: "clawdi.runtimeAppliedState.v1",
			etag: '"legacy"',
			sourceRevision: null,
			generation: 6,
			providerIds: null,
		});
	});
});
