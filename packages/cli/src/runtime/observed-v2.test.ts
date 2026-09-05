import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { getCliVersion } from "../lib/version";
import { writeRuntimeAppliedState } from "./applied-state";
import { readHostedRuntimeObserved } from "./observed";
import { getRuntimePaths } from "./paths";
import { buildRuntimeBootStatus, writeRuntimeBootStatus, writeRuntimeWatchStatus } from "./state";
import { recordRuntimeUserActivityScan } from "./user-activity-state";

const originalEnv = { ...process.env };
const roots: string[] = [];

afterEach(() => {
	process.env = { ...originalEnv };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function healthyAppliedRuntimePaths() {
	const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-watch-error-"));
	roots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	const paths = getRuntimePaths({ mode: "hosted" });
	mkdirSync(paths.serviceStateRoot);
	writeRuntimeAppliedState(
		{
			schemaVersion: "clawdi.runtimeAppliedState.v2",
			appliedAt: "2026-08-19T00:00:00.000Z",
			instanceId: "hri_watch_error",
			etag: '"bundle-applied"',
			manifestETag: '"manifest-applied"',
			applyReceiptId: "apply-receipt-watch-error",
			bootNonce: "boot-nonce-watch-error",
			sourceRevision: "d".repeat(64),
			generation: 1,
			contentIdentity: {
				sourcePath: "https://runtime.test/v1/runtime/manifest",
				sha256: "e".repeat(64),
			},
			activated: {},
			providerIds: [],
			projectedProviderIds: {},
		},
		paths,
	);
	writeRuntimeBootStatus(
		buildRuntimeBootStatus(
			{
				mode: "normal",
				status: "ok",
				stage: "final",
				bootId: "boot-watch-error",
				runtimeMode: "hosted",
				activeGeneration: 1,
				instanceId: "hri_watch_error",
				enabledRuntimes: ["hermes"],
				errors: [],
				exitCode: 0,
				datasource: "RuntimeSource",
				hostPolicy: {
					source: "file",
					path: paths.hostPolicy,
					exists: true,
					valid: true,
					mode: "hosted",
				},
				timestamp: "2026-08-19T00:00:00.000Z",
			},
			paths,
		),
		paths,
	);
	return paths;
}

describe("hosted runtime observed v2", () => {
	test("reports applied authority and keeps status version separate from the active process", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const paths = getRuntimePaths({ mode: "hosted" });
		mkdirSync(paths.serviceStateRoot);
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
				generation: 2,
				applyGeneration: 1,
				contentIdentity: {
					sourcePath: "https://runtime.test/v1/runtime/manifest",
					sha256: "b".repeat(64),
				},
				activated: {},
				providerIds: ["managed"],
				projectedProviderIds: { openclaw: ["managed", "fallback"] },
			},
			paths,
		);
		mkdirSync(dirname(paths.cliBootstrapStatus), { recursive: true });
		writeFileSync(
			paths.cliBootstrapStatus,
			JSON.stringify({
				schemaVersion: "clawdi.cliNpmBootstrapStatus.v1",
				generatedAt: "2026-07-13T06:00:00.000Z",
				status: "installed",
				source: "npm",
				packageSpec: "clawdi@0.0.0-stale",
				registry: "https://registry.npmjs.org",
				npmPrefix: paths.cliNpmPrefix,
				npmCache: paths.cliNpmCache,
				activePath: paths.cliManagedBin,
				activeTarget: join(paths.cliNpmPrefix, "bin", "clawdi"),
				version: "0.0.0-stale",
				verification: {
					verifiedAt: "2026-07-13T06:00:00.000Z",
					device: 0,
					inode: 0,
					size: 0,
					modifiedAtMs: 0,
				},
				previous: null,
				bad: null,
				error: null,
			}),
		);

		const observed = readHostedRuntimeObserved(paths);
		expect(observed?.schemaVersion).toBe("clawdi.hostedRuntimeObserved.v2");
		expect(observed?.activeCliVersion).toBe(getCliVersion());
		expect(observed?.cli?.version).toBe("0.0.0-stale");
		expect(observed?.applied).toEqual({
			etag: '"bundle-applied"',
			sourceRevision: "a".repeat(64),
			generation: 1,
			instanceId: "hri_observed",
			appliedProviderIds: ["managed"],
		});
		expect(JSON.stringify(observed)).not.toContain("b".repeat(64));
		expect(observed?.applied).not.toHaveProperty("contentIdentity");
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

	test("keeps last-good runtime healthy when a desired projection fails", () => {
		const paths = healthyAppliedRuntimePaths();
		writeRuntimeWatchStatus(
			{
				status: "error",
				stage: "final",
				error: "runtime hermes sourced Skill projection failed",
				healthImpact: "resource_projection",
			},
			paths,
		);

		const observed = readHostedRuntimeObserved(paths);
		expect(observed?.status).toBe("ok");
		expect(observed?.convergeError).toBe("runtime hermes sourced Skill projection failed");
	});

	test("reports durable Hermes user activity through the existing observation contract", () => {
		const paths = healthyAppliedRuntimePaths();
		process.env.CLAWDI_STATE_DIR = join(paths.serviceStateRoot, "activity");
		recordRuntimeUserActivityScan({
			agentType: "hermes",
			userActivity: {
				lastUserInputAt: "2026-08-19T01:00:00.000Z",
				complete: true,
			},
			complete: true,
			observedAt: new Date("2026-08-19T02:00:00.000Z"),
		});

		expect(readHostedRuntimeObserved(paths)).not.toHaveProperty("userActivity");
		expect(readHostedRuntimeObserved(paths, { includeUserActivity: true })?.userActivity).toEqual({
			schemaVersion: 1,
			classifierVersion: 1,
			classification: "known_last_user_input",
			lastUserInputAt: "2026-08-19T01:00:00.000Z",
			observedAt: "2026-08-19T02:00:00.000Z",
			completeAt: "2026-08-19T02:00:00.000Z",
			enabledRuntimes: ["hermes"],
		});
	});

	test("reports an untyped watch apply failure as unhealthy", () => {
		const paths = healthyAppliedRuntimePaths();
		writeRuntimeWatchStatus(
			{
				status: "error",
				stage: "final",
				error: "runtime apply failed",
			},
			paths,
		);

		const observed = readHostedRuntimeObserved(paths);
		expect(observed?.status).toBe("error");
		expect(observed?.convergeError).toBe("runtime apply failed");
	});

	test("reports complete systemd counts with representative scoped truncation", () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-truncation-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_RUNTIME_USER = userInfo().username;
		const paths = getRuntimePaths({ mode: "hosted" });
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		const systemctl = join(root, "systemctl");
		writeFileSync(systemctl, "#!/bin/sh\nprintf 'ActiveState=active\\nSubState=running\\n'\n");
		chmodSync(systemctl, 0o700);
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		for (let index = 0; index < 31; index += 1) {
			const suffix = index.toString().padStart(2, "0");
			writeFileSync(join(paths.systemdSystemRoot, `clawdi-system-${suffix}.service`), "");
			writeFileSync(join(paths.systemdUserRoot, `clawdi-user-${suffix}.service`), "");
		}

		const observed = readHostedRuntimeObserved(paths);

		expect(observed?.truncated).toBe(true);
		expect(observed?.systemd?.unitCount).toBe(62);
		expect(observed?.systemd?.units).toHaveLength(30);
		expect(observed?.systemd?.units.filter((unit) => unit.scope === "system")).toHaveLength(15);
		expect(observed?.systemd?.units.filter((unit) => unit.scope === "user")).toHaveLength(15);
	});
});
