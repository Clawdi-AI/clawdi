import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { getCliVersion } from "../lib/version";
import { readRuntimeAppliedState, writeRuntimeAppliedState } from "./applied-state";
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

function healthyAppliedRuntimePaths(enabledRuntimes: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-watch-error-"));
	roots.push(root);
	process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
	process.env.CLAWDI_RUN_DIR = join(root, "run");
	process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
	process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "systemd");
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
				enabledRuntimes,
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
	test("reports applied authority and keeps status version separate from the active process", async () => {
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

		const observed = await readHostedRuntimeObserved(paths);
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

	test("reports missing applied state as unknown authority", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-legacy-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		const observed = await readHostedRuntimeObserved(getRuntimePaths({ mode: "hosted" }));
		expect(observed?.applied).toBeNull();
		expect(observed?.status).toBe("unknown");
	});

	test("keeps last-good runtime healthy when a desired projection fails", async () => {
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

		const observed = await readHostedRuntimeObserved(paths);
		expect(observed?.status).toBe("ok");
		expect(observed?.convergeError).toBe("runtime hermes sourced Skill projection failed");
	});

	test("reports durable Hermes user activity through the existing observation contract", async () => {
		const paths = healthyAppliedRuntimePaths(["hermes"]);
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

		expect(await readHostedRuntimeObserved(paths)).not.toHaveProperty("userActivity");
		expect(
			(await readHostedRuntimeObserved(paths, { includeUserActivity: true }))?.userActivity,
		).toEqual({
			schemaVersion: 1,
			classifierVersion: 1,
			classification: "known_last_user_input",
			lastUserInputAt: "2026-08-19T01:00:00.000Z",
			observedAt: "2026-08-19T02:00:00.000Z",
			completeAt: "2026-08-19T02:00:00.000Z",
			enabledRuntimes: ["hermes"],
		});
	});

	test("reports an untyped watch apply failure as unhealthy", async () => {
		const paths = healthyAppliedRuntimePaths();
		writeRuntimeWatchStatus(
			{
				status: "error",
				stage: "final",
				error: "runtime apply failed",
			},
			paths,
		);

		const observed = await readHostedRuntimeObserved(paths);
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
	])(
		"requires $runtime serving readiness after systemd activation",
		async ({ runtime, unit, ready, pending }) => {
			const paths = healthyAppliedRuntimePaths([runtime]);
			const identity = userInfo();
			process.env.CLAWDI_RUNTIME_USER = identity.username;
			// Bun's username follows USER; numeric credentials identify the actual test process.
			process.env.CLAWDI_RUNTIME_UID = String(identity.uid);
			process.env.CLAWDI_RUNTIME_GID = String(identity.gid);
			mkdirSync(paths.systemdUserRoot, { recursive: true });
			writeFileSync(join(paths.systemdUserRoot, unit), GENERATED_RUNTIME_SYSTEMD_FILE_HEADER);
			const gatewayUnit = join(paths.systemdUserRoot, "hermes-gateway.service");
			if (unit === "clawdi-hermes-dashboard.service") {
				writeFileSync(gatewayUnit, GENERATED_RUNTIME_SYSTEMD_FILE_HEADER);
			}
			const systemctl = join(paths.userHome, "systemctl");
			writeFileSync(systemctl, "#!/bin/sh\nprintf 'ActiveState=active\nSubState=running\n'\n", {
				mode: 0o700,
			});
			process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
			let body: unknown = ready;
			let uiStatus = 200;
			let probeStatus = 200;
			let probeWait: Promise<void> | undefined;
			let releaseProbe: (() => void) | undefined;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: unit === "openclaw-gateway.service" ? 0 : 9119,
				async fetch(request) {
					if (probeWait) await probeWait;
					const path = new URL(request.url).pathname;
					if (path === "/control/") return new Response(null, { status: uiStatus });
					if (path !== "/readyz" && path !== "/api/status")
						return new Response(null, { status: 404 });
					return new Response(typeof body === "string" ? body : JSON.stringify(body), {
						status: probeStatus,
					});
				},
			});
			const configPath = join(paths.userHome, ".openclaw", "openclaw.json");
			mkdirSync(dirname(configPath), { recursive: true });
			const config = `{ // Native OpenClaw configuration supports JSON5.
  gateway: { port: ${server.port}, controlUi: { basePath: '/control' } },
}`;
			writeFileSync(configPath, config);
			try {
				for (const response of [...pending, null, "not JSON", ready, ...pending]) {
					body = response;
					const observed = await readHostedRuntimeObserved(paths);
					expect(
						observed?.systemd?.units.find((candidate) => candidate.name === unit)?.activeState,
					).toBe("active");
					expect(observed?.status).toBe(response === ready ? "ok" : "unknown");
				}
				body = ready;
				probeStatus = 503;
				expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
				probeStatus = 200;
				if (unit === "openclaw-gateway.service") {
					for (const status of [503, 404, 302, 200]) {
						uiStatus = status;
						expect((await readHostedRuntimeObserved(paths))?.status).toBe(
							status === 200 ? "ok" : "unknown",
						);
					}
					// An absent or stale optional manifest cache must not override native configuration.
					mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
					writeFileSync(
						paths.manifestLastGood,
						JSON.stringify({ manifest: { system: { openclawControlUiBasePath: "/stale" } } }),
					);
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("ok");
					for (const invalid of ["{}", "not JSON"]) {
						writeFileSync(configPath, invalid);
						expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
					}
					rmSync(configPath);
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
					// Native includes are resolved by OpenClaw's existing config command contract.
					mkdirSync(paths.userLocalBin, { recursive: true });
					const nativeCommand = join(paths.userLocalBin, "openclaw");
					writeFileSync(
						nativeCommand,
						`#!/bin/sh
[ "$*" = "config get gateway --json" ] || exit 1
[ "$OPENCLAW_CONFIG_PATH" = "$HOME/.openclaw/openclaw.json" ] || exit 1
printf '%s' '{"port":${server.port},"controlUi":{"basePath":"/control"}}'
`,
						{ mode: 0o700 },
					);
					for (const included of [
						{ $include: "native.json" },
						{ gateway: { $include: "gateway.json" } },
						{ gateway: { port: server.port, controlUi: { $include: "ui.json" } } },
					]) {
						writeFileSync(configPath, JSON.stringify(included));
						expect((await readHostedRuntimeObserved(paths))?.status).toBe("ok");
					}
					rmSync(nativeCommand);
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
					writeFileSync(configPath, config);
					// An HTTP server that accepts but never replies must not freeze observation.
					probeWait = new Promise<void>((resolve) => {
						releaseProbe = resolve;
					});
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
				} else {
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
					expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
				}
			} finally {
				releaseProbe?.();
				await server.stop(true);
			}
			expect((await readHostedRuntimeObserved(paths))?.status).toBe("unknown");
		},
	);

	test("requires boot-selected services when the receipt has no activation inventory", async () => {
		const paths = healthyAppliedRuntimePaths(["hermes"]);
		const observed = await readHostedRuntimeObserved(paths);
		expect(observed?.status).toBe("unknown");
		expect(observed?.systemd?.units.map((unit) => unit.name)).toEqual([
			"clawdi-hermes-dashboard.service",
			"hermes-gateway.service",
		]);
	});

	test("keeps missing and truncated applied services from reporting healthy", async () => {
		const paths = healthyAppliedRuntimePaths();
		const applied = readRuntimeAppliedState(paths);
		if (!applied) throw new Error("Fixture is missing applied state");
		writeRuntimeAppliedState(
			{ ...applied, activated: { "hermes-gateway.service": "a".repeat(64) } },
			paths,
		);
		const identity = userInfo();
		process.env.CLAWDI_RUNTIME_USER = identity.username;
		process.env.CLAWDI_RUNTIME_UID = String(identity.uid);
		process.env.CLAWDI_RUNTIME_GID = String(identity.gid);
		mkdirSync(paths.userHome, { recursive: true });
		const systemctl = join(paths.userHome, "systemctl");
		writeFileSync(
			systemctl,
			`#!/bin/sh
case "$*" in
  *hermes-gateway.service*) printf 'ActiveState=inactive\\nSubState=dead\\n' ;;
  *) printf 'ActiveState=active\\nSubState=running\\n' ;;
esac
`,
			{ mode: 0o700 },
		);
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const missing = await readHostedRuntimeObserved(paths);
		expect(missing?.status).toBe("unknown");
		expect(missing?.systemd?.units).toMatchObject([
			{ name: "hermes-gateway.service", activeState: "inactive" },
		]);
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		for (let index = 0; index < 31; index += 1) {
			writeFileSync(
				join(paths.systemdUserRoot, `clawdi-extra-${index}.service`),
				GENERATED_RUNTIME_SYSTEMD_FILE_HEADER,
			);
		}
		const truncated = await readHostedRuntimeObserved(paths);
		expect(truncated?.truncated).toBe(true);
		expect(truncated?.systemd?.units.some((unit) => unit.name === "hermes-gateway.service")).toBe(
			false,
		);
		expect(truncated?.status).toBe("unknown");
	});

	test("reports complete systemd counts with representative scoped truncation", async () => {
		const root = mkdtempSync(join(tmpdir(), "clawdi-observed-v2-truncation-"));
		roots.push(root);
		process.env.CLAWDI_SERVICE_STATE_DIR = join(root, "state");
		process.env.CLAWDI_RUN_DIR = join(root, "run");
		process.env.CLAWDI_RUNTIME_HOME = join(root, "home");
		process.env.CLAWDI_RUNTIME_USER = userInfo().username;
		process.env.CLAWDI_RUNTIME_UID = String(userInfo().uid);
		process.env.CLAWDI_RUNTIME_GID = String(userInfo().gid);
		process.env.CLAWDI_SYSTEMD_SYSTEM_ROOT = join(root, "systemd");
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

		const observed = await readHostedRuntimeObserved(paths);

		expect(observed?.truncated).toBe(true);
		expect(observed?.systemd?.unitCount).toBe(62);
		expect(observed?.systemd?.units).toHaveLength(30);
		expect(observed?.systemd?.units.filter((unit) => unit.scope === "system")).toHaveLength(15);
		expect(observed?.systemd?.units.filter((unit) => unit.scope === "user")).toHaveLength(15);
	});
});
