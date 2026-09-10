import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { getCliVersion } from "../lib/version";
import { writeRuntimeAppliedState } from "./applied-state";
import { readHostedRuntimeObserved } from "./observed";
import { getRuntimePaths } from "./paths";
import { buildRuntimeBootStatus, writeRuntimeBootStatus, writeRuntimeWatchStatus } from "./state";
import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "./systemd-user";
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

	test.each([
		{
			runtime: "openclaw",
			unit: "openclaw-gateway.service",
			ready: { ready: true },
			pending: [{ ready: false }, { ok: true }],
		},
		{
			runtime: "hermes",
			unit: "clawdi-hermes-dashboard.service",
			ready: {
				gateway_running: true,
				gateway_state: "running",
				auth_required: true,
				auth_providers: ["basic"],
			},
			pending: [
				{
					gateway_running: true,
					gateway_state: "starting",
					auth_required: true,
					auth_providers: ["basic"],
				},
				{
					gateway_running: false,
					gateway_state: "running",
					auth_required: true,
					auth_providers: ["basic"],
				},
				{
					gateway_running: true,
					gateway_state: "running",
					auth_required: false,
					auth_providers: [],
				},
			],
		},
	])("requires $runtime serving readiness after systemd activation", ({ unit, ready, pending }) => {
		const paths = healthyAppliedRuntimePaths();
		process.env.CLAWDI_RUNTIME_USER = userInfo().username;
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		writeFileSync(join(paths.systemdUserRoot, unit), GENERATED_RUNTIME_SYSTEMD_FILE_HEADER);
		if (unit === "clawdi-hermes-dashboard.service") {
			writeFileSync(
				join(paths.systemdUserRoot, "hermes-gateway.service"),
				GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
			);
		}
		const systemctl = join(paths.serviceStateRoot, "systemctl");
		writeFileSync(systemctl, "#!/bin/sh\nprintf 'ActiveState=active\\nSubState=running\\n'\n", {
			mode: 0o700,
		});
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const curl = join(paths.serviceStateRoot, "curl");
		writeFileSync(
			curl,
			`#!/bin/sh
case "$*" in
  *--head*http://127.0.0.1:18789/control/) cat "$CLAWDI_SERVICE_STATE_DIR/ui-status" ;;
  *--head*) exit 1 ;;
  *) cat "$CLAWDI_SERVICE_STATE_DIR/probe.json" ;;
esac
`,
			{ mode: 0o700 },
		);
		mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify({ manifest: { system: { openclawControlUiBasePath: "/control" } } }),
		);
		const uiStatusPath = join(paths.serviceStateRoot, "ui-status");
		writeFileSync(uiStatusPath, "200");
		process.env.PATH = `${paths.serviceStateRoot}:${originalEnv.PATH}`;
		const responsePath = join(paths.serviceStateRoot, "probe.json");

		for (const response of [...pending, null, "not JSON", ready, ...pending]) {
			writeFileSync(
				responsePath,
				typeof response === "string" ? response : JSON.stringify(response),
			);
			const observed = readHostedRuntimeObserved(paths);
			expect(observed?.status).toBe(response === ready ? "ok" : "unknown");
			expect(observed?.systemd?.units[0]?.activeState).toBe("active");
		}
		writeFileSync(responsePath, JSON.stringify(ready));
		if (unit === "clawdi-hermes-dashboard.service") {
			writeFileSync(
				systemctl,
				`#!/bin/sh
case "$*" in
  *hermes-gateway.service*) printf 'ActiveState=activating\\nSubState=start\\n' ;;
  *) printf 'ActiveState=active\\nSubState=running\\n' ;;
esac
`,
				{ mode: 0o700 },
			);
			expect(readHostedRuntimeObserved(paths)?.status).toBe("unknown");
		}
		if (unit === "openclaw-gateway.service") {
			for (const statusCode of ["503", "404", "302", "200"]) {
				writeFileSync(uiStatusPath, statusCode);
				expect(readHostedRuntimeObserved(paths)?.status).toBe(
					statusCode === "200" ? "ok" : "unknown",
				);
			}
		}
		writeFileSync(curl, "#!/bin/sh\nexit 28\n", { mode: 0o700 });
		expect(readHostedRuntimeObserved(paths)?.status).toBe("unknown");
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
