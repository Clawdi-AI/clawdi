import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RuntimeAppliedState } from "./applied-state";
import { readHostedAgentPluginsObservation } from "./hosted-agent-plugin-observation";
import {
	hostedAgentPluginReceiptsPath,
	writeHostedAgentPluginReceipt,
} from "./hosted-agent-plugin-package";
import { readHostedRuntimeObserved } from "./observed";
import { getRuntimePaths, type RuntimePaths } from "./paths";

const roots: string[] = [];
const originalEnv = { ...process.env };
const installationId = "11111111-1111-4111-8111-111111111111";
const sourceRevision = "a".repeat(64);

afterEach(() => {
	process.env = { ...originalEnv };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempPaths(): RuntimePaths {
	const root = mkdtempSync(join(tmpdir(), "clawdi-agent-plugin-observation-"));
	roots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	const paths = getRuntimePaths({ mode: "hosted" });
	mkdirSync(paths.serviceStateRoot, { recursive: true });
	return paths;
}

function installation(version: string, digest: string) {
	return {
		installationId,
		version,
		agentPluginsSchema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" as const,
		source: {
			type: "github" as const,
			url: "https://github.com/Clawdi-AI/store",
			path: "v2/plugins/clawdi",
			commit: "b".repeat(40),
		},
		contentDigest: `sha256-tree-v1:${digest.repeat(64)}`,
	};
}

function appliedState(): RuntimeAppliedState {
	return {
		schemaVersion: "clawdi.runtimeAppliedState.v2",
		appliedAt: "2026-08-15T00:00:00.000Z",
		instanceId: "runtime-agent-plugin-observation",
		etag: `"sha256:${sourceRevision}"`,
		sourceRevision,
		generation: 3,
		applyGeneration: 7,
		manifestETag: '"manifest-agent-plugin-observation"',
		applyReceiptId: "apply-receipt-agent-plugin-observation",
		bootNonce: "boot-nonce-agent-plugin-observation",
		contentIdentity: {
			sourcePath: "https://runtime.test/v1/runtime/manifest",
			sha256: "c".repeat(64),
		},
		providerIds: [],
		projectedProviderIds: {},
	};
}

function writeAppliedManifest(paths: RuntimePaths, desired: ReturnType<typeof installation>): void {
	mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
	writeFileSync(
		paths.manifestLastGood,
		JSON.stringify({
			instanceId: "runtime-agent-plugin-observation",
			generation: 3,
			applyGeneration: 7,
			projection: {
				agentPlugins: {
					schemaVersion: 1,
					installations: { clawdi: desired },
				},
			},
		}),
	);
}

function writeReceipt(paths: RuntimePaths, desired: ReturnType<typeof installation>): void {
	writeHostedAgentPluginReceipt(
		{
			schemaVersion: "clawdi.hostedAgentPluginReceipts.v2",
			runtime: "openclaw",
			installations: {
				clawdi: {
					...desired,
					ownershipIdentity: "f".repeat(64),
					nativeId: "clawdi",
				},
			},
		},
		paths,
	);
}

function failedWatchStatus(desired: ReturnType<typeof installation>, generation: number) {
	return {
		event: {
			status: "error",
			agentPlugins: {
				schemaVersion: 1,
				installations: [
					{
						installationId,
						name: "clawdi",
						version: desired.version,
						contentDigest: desired.contentDigest,
						sourceRevision: "1".repeat(64),
						generation,
						status: "failed",
						errorCode: "reconcile_failed",
					},
				],
			},
		},
	};
}

describe("hosted Agent Plugin heartbeat observation", () => {
	test("keeps Agent Plugin evidence on the v2 companion heartbeat", () => {
		const paths = tempPaths();
		const desired = installation("1.0.0", "d");
		const applied = appliedState();
		writeAppliedManifest(paths, desired);
		writeReceipt(paths, desired);

		expect(readHostedRuntimeObserved(paths, { appliedState: applied })).not.toHaveProperty(
			"agentPlugins",
		);
		expect(
			readHostedRuntimeObserved(paths, {
				appliedState: applied,
				includeAgentPlugins: true,
			})?.agentPlugins?.installations[0]?.status,
		).toBe("installed");
	});

	test("reports only the identity-fenced failed revision instead of an old receipt", () => {
		const paths = tempPaths();
		const previous = installation("1.0.0", "d");
		const desired = installation("1.1.0", "e");
		writeAppliedManifest(paths, previous);
		writeReceipt(paths, previous);

		const observed = readHostedAgentPluginsObservation({
			paths,
			applied: appliedState(),
			watchStatus: failedWatchStatus(desired, 8),
		});

		expect(observed?.installations).toEqual([
			{
				installationId,
				name: "clawdi",
				version: "1.1.0",
				contentDigest: `sha256-tree-v1:${"e".repeat(64)}`,
				sourceRevision: "1".repeat(64),
				generation: 8,
				status: "failed",
				errorCode: "reconcile_failed",
			},
		]);
	});

	test("does not promote a failed revision when rollback left its candidate receipt", () => {
		const paths = tempPaths();
		const previous = installation("1.0.0", "d");
		const desired = installation("1.1.0", "e");
		writeAppliedManifest(paths, previous);
		writeReceipt(paths, desired);

		const observed = readHostedAgentPluginsObservation({
			paths,
			applied: appliedState(),
			watchStatus: failedWatchStatus(desired, 8),
		});

		expect(observed?.installations[0]?.status).toBe("failed");
		expect(observed?.installations[0]?.generation).toBe(8);
	});

	test("ignores failure evidence older than the applied receipt identity", () => {
		const paths = tempPaths();
		const desired = installation("1.0.0", "d");
		writeAppliedManifest(paths, desired);
		writeReceipt(paths, desired);

		const observed = readHostedAgentPluginsObservation({
			paths,
			applied: appliedState(),
			watchStatus: failedWatchStatus(desired, 6),
		});

		expect(observed?.installations).toEqual([
			{
				installationId,
				name: "clawdi",
				version: "1.0.0",
				contentDigest: `sha256-tree-v1:${"d".repeat(64)}`,
				sourceRevision,
				generation: 7,
				status: "installed",
			},
		]);
	});

	test("keeps heartbeat readable and reports unknown when the receipt is corrupt", () => {
		const paths = tempPaths();
		const desired = installation("1.0.0", "d");
		writeAppliedManifest(paths, desired);
		const receiptPath = hostedAgentPluginReceiptsPath(paths);
		mkdirSync(dirname(receiptPath), { recursive: true });
		writeFileSync(receiptPath, "{", { mode: 0o600 });

		expect(
			readHostedAgentPluginsObservation({
				paths,
				applied: appliedState(),
				watchStatus: null,
			})?.installations,
		).toEqual([
			{
				installationId,
				name: "clawdi",
				version: "1.0.0",
				contentDigest: `sha256-tree-v1:${"d".repeat(64)}`,
				sourceRevision,
				generation: 7,
				status: "unknown",
				errorCode: "receipt_unreadable",
			},
		]);
	});
});
