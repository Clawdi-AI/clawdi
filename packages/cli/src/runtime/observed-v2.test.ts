import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getCliVersion } from "../lib/version";
import { writeRuntimeAppliedState } from "./applied-state";
import { readHostedRuntimeObserved } from "./observed";
import { getRuntimePaths } from "./paths";

const originalEnv = { ...process.env };
const roots: string[] = [];

afterEach(() => {
	process.env = { ...originalEnv };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("hosted runtime observed v2", () => {
	test("reports authority only from applied state and the active process version", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const paths = getRuntimePaths({ mode: "hosted" });
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T06:00:00.000Z",
				instanceId: "hri_observed",
				etag: '"bundle-applied"',
				manifestETag: '"frozen-companion-manifest"',
				applyReceiptId: "apply-receipt-observed-v2",
				bootNonce: "boot-nonce-observed-v2-01",
				sourceRevision: "a".repeat(64),
				generation: 9,
				contentIdentity: {
					sourcePath: "https://runtime.test/v1/runtime/manifest",
					sha256: "b".repeat(64),
				},
				providerIds: ["managed"],
				projectedProviderIds: { openclaw: ["managed", "fallback"] },
			},
			paths,
		);
		mkdirSync(dirname(paths.cliBootstrapStatus), { recursive: true });
		writeFileSync(paths.cliBootstrapStatus, JSON.stringify({ version: "0.0.0-stale" }));

		const observed = readHostedRuntimeObserved(paths);
		expect(observed?.schemaVersion).toBe("clawdi.hostedRuntimeObserved.v2");
		expect(observed?.activeCliVersion).toBe(getCliVersion());
		expect(observed?.applied).toEqual({
			etag: '"bundle-applied"',
			sourceRevision: "a".repeat(64),
			generation: 9,
			instanceId: "hri_observed",
			appliedProviderIds: ["managed"],
		});
	});

	test("reports missing applied state as unknown authority", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-legacy-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const observed = readHostedRuntimeObserved(getRuntimePaths({ mode: "hosted" }));
		expect(observed?.applied).toBeNull();
		expect(observed?.status).toBe("unknown");
	});
});
