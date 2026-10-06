import { describe, expect, it, spyOn } from "bun:test";

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";

import { dirname, join } from "node:path";

import { parseEnv } from "node:util";

import { runtimeAppliedContentIdentity, runtimeWatchPollDelayMs } from "../src/commands/runtime";

import { readRuntimeAppliedState } from "../src/runtime/applied-state";

import { hostedManifestEgressProfiles } from "../src/runtime/hosted-egress-profiles";

import { cacheRuntimeLastGoodManifest } from "../src/runtime/manifest";

import { HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE } from "../src/runtime/manifest-source";

import { readHostedRuntimeObserved } from "../src/runtime/observed";

import { getRuntimePaths, legacyRuntimeManifestPaths } from "../src/runtime/paths";

import { runtimeSystemdCommonEnvironment } from "../src/runtime/runtime-systemd-reconciliation";

import {
	applySystemdRuntimeUpdate,
	readSystemdUnitSnapshot,
} from "../src/runtime/systemd-transaction";

import { writeFakeOpenClawConfigMutationSdk } from "../src/test-support/openclaw-config-mutation";

import {
	applyRuntimeBundleChannelsToManifestLoad,
	CANONICAL_TEST_CONTEXT,
	convergeRuntimeManifest,
	expectEgressProfileBundleUsesSecretRef,
	explicitTestApplyContext,
	fakeOpenClawConfigPatchCommand,
	fakeOpenClawConfigSchemaCommand,
	fakeSystemdStatePath,
	hostedHermesDashboardCapabilityLoad,
	hostedOpenClawRuntime,
	hostedRequiredState,
	hostedRuntimeBundleResponse,
	hostedRuntimeWatchLocalePayload,
	hostedSystemFixture,
	installRuntimeTestHooks,
	installSuccessfulSystemctlFixture,
	loadRemoteRuntimeManifest,
	readSystemdEnvFile,
	readSystemdSystemUnit,
	root,
	runtimeWatch,
	seedCurrentCliInstall,
	seedFakeSystemdSnapshotProcesses,
	seedMitmproxyCache,
	seedOfficialOpenClawServiceInstaller,
	seedOpenClawBinary,
	seedRuntimeWatchLocaleBaseline,
	setRuntimeApplyContextFixture,
	setRuntimeApplyGeneration,
	startHealthyOpenClawGateway,
	systemdEnvDigest,
	TEST_HOSTED_CODEX_SECRET_REF,
	TEST_HOSTED_CODEX_SECRET_VALUES,
	TEST_HOSTED_CODEX_TERMINAL_TOOLING,
	TEST_HOSTED_LOCALE,
	TEST_PROCESS_USER,
	TEST_RUNNING_CLI_SPEC,
	TEST_RUNNING_CLI_VERSION,
	TEST_RUNTIME_SERVICE_SECRET_VALUES,
	testBundleEtag,
	writeCanonicalApplyContext,
	writeFakeOpenClawProviderAuthSdk,
	writeFakeSystemdManager,
	writeHermesVersionBinary,
	writeOpenClawConfigMutationFixture,
	writeTestRuntimeAppliedState,
} from "../src/test-support/runtime-harness";

import { mockFetch } from "./commands/helpers";

installRuntimeTestHooks();

describe("runtime watch poll delay", () => {
	it("jitters each fallback poll between half and one-and-a-half intervals", () => {
		expect([0, 0.5, 1].map((value) => runtimeWatchPollDelayMs(15_000, () => value))).toEqual([
			7_500, 15_000, 22_500,
		]);
	});
});

describe("runtime manifest datasource", () => {
	it("watch self-heal requests a fresh manifest after unchanged committed metadata", async () => {
		seedRuntimeWatchLocaleBaseline(
			join(root, "home", "clawdi"),
			join(root, "var", "lib", "clawdi"),
			join(root, "run", "clawdi"),
		);
		const abort = new AbortController();
		const previousLog = console.log;
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const events: string[] = [];
		console.log = (value?: unknown) => {
			const event = JSON.parse(String(value));
			events.push(event.status);
			if (event.status === "not_modified") now += 300_001;
		};
		let requests = 0;
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => {
					requests += 1;
					if (requests === 1)
						return new Response(null, {
							status: 304,
							headers: { etag: testBundleEtag("manifest-locale-1") },
						});
					abort.abort();
					return new Response("temporary fixture outage", { status: 503 });
				},
			},
		]);
		const deadline = setTimeout(() => abort.abort(), 3000);
		try {
			await runtimeWatch({
				intervalMs: 10,
				selfHealMs: 300_000,
				notifications: false,
				json: true,
				abort: abort.signal,
			});
			const reads = captured.filter((request) => request.path === "/v1/runtime/manifest");
			expect(events[0]).toBe("not_modified");
			expect(reads).toHaveLength(2);
			expect(reads[0].headers["if-none-match"]).toBe(testBundleEtag("manifest-locale-1"));
			expect(reads[1].headers["if-none-match"]).toBeUndefined();
		} finally {
			clearTimeout(deadline);
			restore();
			clock.mockRestore();
			console.log = previousLog;
		}
	});

	it("runtime watch reconciles changed runtime and egress units without restarting itself", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const systemctlLog = join(root, "systemctl-locale.log");
		const systemctlStateRoot = join(root, "systemctl-locale-state");
		const sidecarReadyPath = join(run, "egress", "systemd", "ca.pem");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		writeFakeSystemdManager({
			path: join(bin, "systemctl"),
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
			sidecarReadyPath,
		});
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		const paths = seedRuntimeWatchLocaleBaseline(home, state, run);
		const baselineUnits = readSystemdUnitSnapshot(paths);
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, baselineUnits);
		for (const unit of baselineUnits.user.keys()) {
			writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
		}
		let resolveInitialWatchEvent: (() => void) | null = null;
		const initialWatchEvent = new Promise<void>((resolveEvent) => {
			resolveInitialWatchEvent = resolveEvent;
		});
		console.log = (value?: unknown) => {
			logs.push(String(value));
			if (logs.length === 1) resolveInitialWatchEvent?.();
		};
		let manifestCalls = 0;
		let manifestRequestsBeforeOwnSignal = 0;
		let resolveInitialManifestRequest: (() => void) | null = null;
		const initialManifestRequest = new Promise<void>((resolveRequest) => {
			resolveInitialManifestRequest = resolveRequest;
		});
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => {
					manifestCalls += 1;
					if (manifestCalls === 1) {
						resolveInitialManifestRequest?.();
						return new Response(null, {
							status: 304,
							headers: { etag: testBundleEtag("manifest-locale-1") },
						});
					}
					setTimeout(() => abort.abort(), 25);
					const payload = hostedRuntimeWatchLocalePayload(home, 2);
					payload.manifest.egressProfiles = hostedManifestEgressProfiles({
						providers: {},
						terminalTooling: TEST_HOSTED_CODEX_TERMINAL_TOOLING,
					});
					payload.secretValues = { [TEST_HOSTED_CODEX_SECRET_REF]: "sk-codex-tool-rotated" };
					return hostedRuntimeBundleResponse(payload, {
						etag: testBundleEtag("manifest-locale-2"),
					});
				},
			},
		]);

		try {
			await runtimeWatch({
				intervalMs: 20,
				selfHealMs: 300_000,
				json: true,
				abort: abort.signal,
				notificationConsumer: async (options) => {
					await options.onEvent({
						type: "runtime_manifest_changed",
						environment_id: "env_other",
					});
					await initialManifestRequest;
					await initialWatchEvent;
					manifestRequestsBeforeOwnSignal = captured.filter(
						(request) => request.path === "/v1/runtime/manifest",
					).length;
					setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
					await options.onEvent({
						type: "runtime_manifest_changed",
						environment_id: "env_watch_locale",
					});
					await new Promise<void>((resolveDone) => {
						if (options.abort.aborted) return resolveDone();
						options.abort.addEventListener("abort", () => resolveDone(), { once: true });
					});
				},
			});

			expect(manifestRequestsBeforeOwnSignal).toBe(1);
			expect(manifestCalls).toBe(2);
			const events = logs.map((line) => JSON.parse(line));
			expect(events[0]).toMatchObject({ status: "not_modified" });
			expect(events[1]).toMatchObject({ status: "applied" });
			expect(events[0].generation).toBe(1);
			expect(events[0].instanceId).toBe("iid_watch_locale");
			expect(events[1].etag).toBe(testBundleEtag("manifest-locale-2"));
			expect(
				captured.filter((request) => request.path === "/v1/runtime/manifest")[1].headers[
					"if-none-match"
				],
			).toBe(testBundleEtag("manifest-locale-1"));
			const systemctlCalls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
			expect(systemctlCalls).toContain("--user restart openclaw-gateway.service");
			expect(systemctlCalls.some((call) => call.includes("enable --now"))).toBe(false);
			expect(systemctlCalls).toContain("restart clawdi-runtime-sidecar.service");
			expect(systemctlCalls).not.toContain("restart clawdi-daemon.service");
			expect(systemctlCalls.some((call) => call.includes("restart clawdi-runtime-watch"))).toBe(
				false,
			);
			expect(systemctlCalls.some((call) => call.includes("stop clawdi-runtime-watch"))).toBe(false);
			const watchStatus = JSON.parse(readFileSync(getRuntimePaths().runtimeWatchStatus, "utf-8"));
			expect(watchStatus.event.generation).toBe(2);
		} finally {
			restore();
			console.log = previousLog;
		}
	});

	it("reapplies an invalidated user unit when its rendered snapshot is unchanged", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const systemctlLog = join(root, "systemctl-invalidation.log");
		const systemctlStateRoot = join(root, "systemctl-invalidation-state");
		const paths = seedRuntimeWatchLocaleBaseline(home, state, run);
		const snapshot = readSystemdUnitSnapshot(paths);
		const unit = "openclaw-gateway.service";

		writeFakeSystemdManager({
			path: join(bin, "systemctl"),
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
		});
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, snapshot);
		writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "failed"), "\n");
		writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "reload"), "\n");
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");

		const activation = applySystemdRuntimeUpdate(paths, snapshot, snapshot, {
			recoverFailedUnits: false,
			invalidatedUserUnits: [unit],
		});

		expect(activation).toMatchObject({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: [unit],
		});
		const calls = readFileSync(systemctlLog, "utf-8").trim().split("\n");
		expect(calls).toContain("--user daemon-reload");
		expect(calls).toContain(`--user reset-failed ${unit}`);
		expect(calls).toContain(`--user start ${unit}`);
	});

	it("reloads manager state changed before the apply snapshot without restarting active services", () => {
		const paths = seedRuntimeWatchLocaleBaseline(
			join(root, "home", "clawdi"),
			join(root, "var", "lib", "clawdi"),
			join(root, "run", "clawdi"),
		);
		const snapshot = readSystemdUnitSnapshot(paths);
		const logPath = join(root, "systemctl-reload.log");
		const stateRoot = join(root, "systemctl-reload-state");
		const command = join(root, "bin", "systemctl");
		writeFakeSystemdManager({ path: command, logPath, stateRoot });
		seedFakeSystemdSnapshotProcesses(paths, stateRoot, snapshot);
		for (const [scope, unit] of [
			["system", "clawdi-runtime-sidecar.service"],
			["user", "openclaw-gateway.service"],
		] as const) {
			writeFileSync(fakeSystemdStatePath(stateRoot, scope, unit, "reload"), "\n");
		}
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_SYSTEMCTL_PATH = command;

		expect(applySystemdRuntimeUpdate(paths, snapshot, snapshot, {})).toMatchObject({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: [],
		});
		const calls = readFileSync(logPath, "utf8").trim().split("\n");
		expect(calls).toContain("daemon-reload");
		expect(calls).toContain("--user daemon-reload");
		expect(calls.some((call) => /\b(?:start|restart|stop)\b/.test(call))).toBe(false);
	});

	it("runtime watch keeps polling after SSE authentication failure", async () => {
		installSuccessfulSystemctlFixture();
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		seedRuntimeWatchLocaleBaseline(home, state, run);
		let resolveInitialWatchEvent: (() => void) | null = null;
		const initialWatchEvent = new Promise<void>((resolveEvent) => {
			resolveInitialWatchEvent = resolveEvent;
		});
		console.log = (value?: unknown) => {
			logs.push(String(value));
			if (logs.length === 1) resolveInitialWatchEvent?.();
		};
		let manifestCalls = 0;
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => {
					manifestCalls += 1;
					if (manifestCalls === 1) return new Response(null, { status: 304 });
					setTimeout(() => abort.abort(), 0);
					return hostedRuntimeBundleResponse(hostedRuntimeWatchLocalePayload(home, 2), {
						etag: testBundleEtag("manifest-locale-2"),
					});
				},
			},
		]);

		try {
			await runtimeWatch({
				intervalMs: 20,
				selfHealMs: 300_000,
				json: true,
				abort: abort.signal,
				notificationConsumer: async (options) => {
					await initialWatchEvent;
					setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
					options.onAuthFailure?.();
				},
			});

			expect(manifestCalls).toBe(2);
			const events = logs.map((line) => JSON.parse(line));
			expect(events[0]).toMatchObject({ status: "not_modified" });
			expect(events[1]).toMatchObject({ status: "applied" });
		} finally {
			restore();
			console.log = previousLog;
		}
	});

	it.each(["authentication failure", "task completion"])(
		"runtime watch re-subscribes after SSE %s with unchanged connection identity",
		async (completionMode) => {
			installSuccessfulSystemctlFixture();
			const home = join(root, "home", "clawdi");
			const state = join(root, "var", "lib", "clawdi");
			const run = join(root, "run", "clawdi");
			const abort = new AbortController();
			const previousLog = console.log;
			const logs: string[] = [];
			const paths = seedRuntimeWatchLocaleBaseline(home, state, run);
			let resolveInitialWatchEvent: (() => void) | null = null;
			const initialWatchEvent = new Promise<void>((resolveEvent) => {
				resolveInitialWatchEvent = resolveEvent;
			});
			console.log = (value?: unknown) => {
				logs.push(String(value));
				if (logs.length === 1) resolveInitialWatchEvent?.();
			};
			let manifestCalls = 0;
			let authorityBeforeDuplicate: string | null = null;
			let subscriptionCalls = 0;
			let resolveInitialManifestRequest: (() => void) | null = null;
			const initialManifestRequest = new Promise<void>((resolveRequest) => {
				resolveInitialManifestRequest = resolveRequest;
			});
			const { restore } = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () => {
						manifestCalls += 1;
						if (manifestCalls === 1) {
							resolveInitialManifestRequest?.();
							return new Response(null, { status: 304 });
						}
						if (manifestCalls === 3)
							authorityBeforeDuplicate = readFileSync(paths.appliedState, "utf8");
						setTimeout(() => abort.abort(), 0);
						return hostedRuntimeBundleResponse(
							{
								...hostedRuntimeWatchLocalePayload(home, 2),
								secretValues: { [TEST_HOSTED_CODEX_SECRET_REF]: "sk-codex-tool-rotated" },
							},
							{ etag: testBundleEtag("manifest-locale-2") },
						);
					},
				},
			]);
			const timeout = setTimeout(() => abort.abort(), 500);

			try {
				await runtimeWatch({
					intervalMs: 20,
					selfHealMs: 300_000,
					json: true,
					abort: abort.signal,
					notificationConsumer: async (options) => {
						subscriptionCalls += 1;
						if (subscriptionCalls === 1) {
							await initialWatchEvent;
							setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
							if (completionMode === "authentication failure") options.onAuthFailure?.();
							return;
						}
						await initialManifestRequest;
						await initialWatchEvent;
						await options.onEvent({
							type: "runtime_manifest_changed",
							environment_id: "env_watch_locale",
						});
						await new Promise<void>((resolveDone) => {
							if (options.abort.aborted) return resolveDone();
							options.abort.addEventListener("abort", () => resolveDone(), { once: true });
						});
					},
				});

				expect(subscriptionCalls).toBe(2);
				expect(manifestCalls).toBe(3);
				expect(logs.map((line) => JSON.parse(line).status)).toEqual([
					"not_modified",
					"applied",
					"not_modified",
				]);
				expect(readFileSync(paths.appliedState, "utf8")).toBe(authorityBeforeDuplicate);
			} finally {
				clearTimeout(timeout);
				restore();
				console.log = previousLog;
			}
		},
	);

	it("runtime watch probes a failed ETag without reconverging and applies a new ETag", async () => {
		installSuccessfulSystemctlFixture();
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		const paths = seedRuntimeWatchLocaleBaseline(home, state, run);
		setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
		const badEtag = testBundleEtag("manifest-locale-bad-2");
		const goodEtag = testBundleEtag("manifest-locale-good-2");
		const badPayload = hostedRuntimeWatchLocalePayload(home, 2);
		let manifestCalls = 0;
		let deferredEvent: unknown = null;
		const sameEtagProbeStarted = Promise.withResolvers<void>();
		const releaseSameEtagProbe = Promise.withResolvers<void>();
		const recoveryProbeStarted = Promise.withResolvers<void>();
		const releaseRecoveryProbe = Promise.withResolvers<void>();
		console.log = (value?: unknown) => {
			const line = String(value);
			logs.push(line);
			const event = JSON.parse(line);
			if (event.status === "applied") abort.abort();
		};
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: async () => {
					manifestCalls += 1;
					if (manifestCalls === 1) {
						return hostedRuntimeBundleResponse(badPayload, {
							etag: badEtag,
							includeRuntimeServiceSecrets: false,
						});
					}
					if (manifestCalls === 2) {
						sameEtagProbeStarted.resolve();
						await releaseSameEtagProbe.promise;
						return hostedRuntimeBundleResponse(badPayload, {
							etag: badEtag,
							includeRuntimeServiceSecrets: false,
						});
					}
					recoveryProbeStarted.resolve();
					await releaseRecoveryProbe.promise;
					return hostedRuntimeBundleResponse(hostedRuntimeWatchLocalePayload(home, 2), {
						etag: goodEtag,
					});
				},
			},
		]);

		try {
			await runtimeWatch({
				intervalMs: 20,
				selfHealMs: 300_000,
				json: true,
				abort: abort.signal,
				notificationConsumer: async (options) => {
					await sameEtagProbeStarted.promise;
					await options.onEvent({
						type: "runtime_manifest_changed",
						environment_id: "env_watch_locale",
					});
					releaseSameEtagProbe.resolve();
					await recoveryProbeStarted.promise;
					deferredEvent = JSON.parse(readFileSync(paths.runtimeWatchStatus, "utf-8")).event;
					releaseRecoveryProbe.resolve();
					await new Promise<void>((resolveDone) => {
						if (options.abort.aborted) return resolveDone();
						options.abort.addEventListener("abort", () => resolveDone(), { once: true });
					});
				},
			});

			expect(captured.map((request) => request.headers["if-none-match"] ?? null)).toEqual([
				testBundleEtag("manifest-locale-1"),
				null, // Independent Vault metadata check.
				badEtag,
				badEtag,
			]);
			const events = logs.map((line) => JSON.parse(line));
			expect(events).toHaveLength(2);
			expect(events[0].error).toContain(
				"Runtime secret secret://runtime/openclaw/gateway-token is unavailable.",
			);
			expect(events[1]).toMatchObject({ status: "applied", etag: goodEtag });
			expect(deferredEvent).toEqual(events[0]);
			expect(readRuntimeAppliedState(paths)).toMatchObject({ generation: 2, etag: goodEtag });
		} finally {
			restore();
			console.log = previousLog;
		}
	});

	it("runtime watch keeps no-ETag failures deferred across SSE notifications", async () => {
		installSuccessfulSystemctlFixture();
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const abort = new AbortController();
		const previousLog = console.log;
		const logs: string[] = [];
		const paths = seedRuntimeWatchLocaleBaseline(home, state, run);
		setRuntimeApplyGeneration(2, CANONICAL_TEST_CONTEXT);
		const failure = Promise.withResolvers<void>();
		let subscriptionCalls = 0;
		console.log = (value?: unknown) => {
			const line = String(value);
			logs.push(line);
			failure.resolve();
		};
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => new Response("temporary failure", { status: 503 }),
			},
		]);

		try {
			await runtimeWatch({
				intervalMs: 20,
				selfHealMs: 300_000,
				json: true,
				abort: abort.signal,
				notificationConsumer: async (options) => {
					subscriptionCalls += 1;
					if (subscriptionCalls === 2) {
						abort.abort();
						return;
					}
					await failure.promise;
					await options.onEvent({
						type: "runtime_manifest_changed",
						environment_id: "env_watch_locale",
					});
				},
			});

			expect(subscriptionCalls).toBe(2);
			expect(captured.map((request) => request.path)).toEqual([
				"/v1/runtime/manifest",
				"/v1/runtime/vaults",
			]);
			expect(logs).toHaveLength(1);
			const originalError = JSON.parse(logs[0]);
			expect(originalError).toMatchObject({ status: "error", stage: "network" });
			expect(JSON.parse(readFileSync(paths.runtimeWatchStatus, "utf-8")).event).toEqual(
				originalError,
			);
		} finally {
			restore();
			console.log = previousLog;
		}
	});

	it("runtime watch receives the gateway token and applies a live channel binding", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawUnit = join(home, ".config", "systemd", "user", "openclaw-gateway.service");
		const sidecarReadyPath = join(run, "egress", "systemd", "ca.pem");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		writeOpenClawConfigMutationFixture(home, { gateway: startHealthyOpenClawGateway(18789) });
		mkdirSync(dirname(openclawBin), { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
if [ "$*" = "agents list --json" ]; then
  printf '[{"id":"main","workspace":"${join(home, ".openclaw", "workspace")}"}]\\n'
  exit 0
fi
${fakeOpenClawConfigPatchCommand(join(home, ".openclaw", "openclaw.json"))}
if [ "$*" = "gateway install --force --json" ]; then
  mkdir -p '${dirname(openclawUnit)}'
  printf '%s\\n' '[Unit]' '[Service]' 'ExecStart=${openclawBin} gateway run' > '${openclawUnit}'
  printf '{"ok":true}\\n'
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
		);
		chmodSync(openclawBin, 0o700);
		writeFakeSystemdManager({
			path: join(bin, "systemctl"),
			logPath: join(root, "systemctl-watch-channel.log"),
			stateRoot: join(root, "systemctl-watch-channel-state"),
			sidecarReadyPath,
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		setRuntimeApplyContextFixture(
			{
				generation: 12,
				manifestETag: '"etag-watch-12"',
				applyReceiptId: "apply-receipt-0012",
				bootNonce: "boot-nonce-000012",
			},
			CANONICAL_TEST_CONTEXT,
		);
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
		seedMitmproxyCache();
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		const { captured, restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					new Response(
						JSON.stringify({
							schemaVersion: "clawdi.hosted-runtime.bundle.v2",
							sourceRevision: "a".repeat(64),
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_watch",
								environmentId: "env_watch",
								...hostedRequiredState(),
								instanceId: "iid_watch",
								generation: 12,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: TEST_RUNNING_CLI_SPEC,
									registry: "https://registry.npmjs.org",
								},
								egressProfiles: { profiles: [] },
								runtimes: {
									openclaw: hostedOpenClawRuntime(),
								},
								providers: {
									default: {
										kind: "openai-compatible",
										type: "custom_openai_compatible",
										baseUrl: "https://provider.test/v1",
										models: [{ id: "gpt-test" }],
										apiMode: "openai_chat",
										apiKeySecretRef: "secret://provider.default.apiKey",
										apiKeyRequired: true,
									},
								},
							},
							channelBindings: [
								{
									provider: "telegram",
									accountKey: "clawdi_accttelegram",
									agentTokenSecretRef: "secret://channels/telegram/clawdi_accttelegram/agent-token",
									placeholderTokenSecretRef:
										"secret://channels/telegram/clawdi_accttelegram/placeholder-token",
								},
							],
							secretValues: {
								"secret://clawdi/auth-token": "file-runtime-token",
								"secret://runtime/openclaw/gateway-token": "gateway-token-watch",
								[TEST_HOSTED_CODEX_SECRET_REF]: "sk-codex-tool",
								"secret://provider.default.apiKey": "sk-provider-watch",
								"secret://channels/telegram/clawdi_accttelegram/agent-token":
									"telegram-agent-token-watch",
								"secret://channels/telegram/clawdi_accttelegram/placeholder-token":
									"999999999:00000000000000000000000000000000",
							},
						}),
						{
							status: 200,
							headers: {
								"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
								etag: `"sha256:${"a".repeat(64)}"`,
							},
						},
					),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });
			expect(process.exitCode).toBe(1);
			expect(readRuntimeAppliedState(getRuntimePaths())).toBeNull();
			const rejected = JSON.parse(logs.at(-1) ?? "{}");
			expect(rejected.status).toBe("error");
			expect(rejected.error).toContain(
				"transparent-egress system prerequisites did not reach readiness",
			);

			process.env.CLAWDI_SYSTEMD_APPLY = "1";
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			if (process.exitCode !== undefined && process.exitCode !== 0) {
				throw new Error(logs.join("\n"));
			}
			expect(captured).toHaveLength(3);
			expect(captured.at(-1)?.path).toBe("/v1/runtime/vaults");
			expect(captured[0].headers.authorization).toBe("Bearer file-runtime-token");
			expect(captured[0].headers.accept).toBe(HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE);
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
			const appliedState = readRuntimeAppliedState(getRuntimePaths());
			expect(appliedState).toMatchObject({
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				instanceId: "iid_watch",
				etag: `"sha256:${"a".repeat(64)}"`,
				sourceRevision: "a".repeat(64),
				generation: 12,
				manifestETag: '"etag-watch-12"',
				applyReceiptId: "apply-receipt-0012",
				bootNonce: "boot-nonce-000012",
				providerIds: ["default"],
			});
			const event = JSON.parse(logs.at(-1) ?? "{}");
			expect(event.status).toBe("applied");
			expect(event.generation).toBe(12);
			expect(event.etag).toBe(`"sha256:${"a".repeat(64)}"`);
			expect(event.convergence.appliedState).toBe(getRuntimePaths().appliedState);
			expect(event.systemdUnitsChanged).toBe(true);
			expect(event.systemdApply).toEqual({
				applied: true,
				systemUnitsChanged: ["clawdi-daemon.service", "clawdi-runtime-sidecar.service"],
				userUnitsChanged: ["openclaw-gateway.service"],
			});
			const watchStatus = JSON.parse(readFileSync(getRuntimePaths().runtimeWatchStatus, "utf-8"));
			expect(watchStatus.event.status).toBe("applied");
			const observed = await readHostedRuntimeObserved(getRuntimePaths());
			expect(observed?.status).toBe("ok");
			expect(observed?.applied).toMatchObject({
				etag: `"sha256:${"a".repeat(64)}"`,
				sourceRevision: "a".repeat(64),
				generation: 12,
				appliedProviderIds: ["default"],
			});
			const paths = getRuntimePaths();
			expect(readSystemdSystemUnit(paths, "clawdi-runtime-watch")).toContain(
				`ExecStart="${paths.cliManagedBin}" "runtime" "watch"`,
			);
			const watchEnv = readSystemdEnvFile(paths, "clawdi-runtime-watch");
			const daemonEnv = readSystemdEnvFile(paths, "clawdi-daemon");
			const gatewayEnv = readSystemdEnvFile(paths, "openclaw-gateway");
			expect(watchEnv).not.toContain("gateway-token-watch");
			expect(watchEnv).not.toContain("OPENCLAW_GATEWAY_TOKEN");
			expect(gatewayEnv).not.toContain("OPENCLAW_GATEWAY_TOKEN");
			expect(gatewayEnv).not.toContain("gateway-token-watch");
			expect(watchEnv).not.toContain("file-runtime-token");
			const patchText = readFileSync(join(home, ".openclaw", "openclaw.json"), "utf-8");
			expect(patchText).toContain('"telegram"');
			expect(patchText).toContain('"botToken"');
			expect(patchText).toContain(
				'"id": "CLAWDI_CHANNEL_TELEGRAM_CLAWDI_ACCTTELEGRAM_AGENT_TOKEN"',
			);
			expect(patchText).not.toContain("telegram-agent-token-watch");
			for (const unitEnv of [watchEnv, daemonEnv]) {
				expect(unitEnv).not.toContain("CLAWDI_RUNTIME_APPLY_IDENTITY_FILE");
				expect(unitEnv).not.toContain("CLAWDI_RUNTIME_GENERATION");
				expect(unitEnv).not.toContain("CLAWDI_RUNTIME_APPLY_RECEIPT_ID");
			}
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("keeps systemd activation unchanged when watch inherits its generated PATH", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const systemctlLog = join(root, "systemctl-path.log");
		const inheritedPath = process.env.PATH;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		installSuccessfulSystemctlFixture(join(run, "egress", "systemd", "ca.pem"), systemctlLog);
		writeHermesVersionBinary(home, "0.20.1");
		seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
		const paths = getRuntimePaths();
		const load = hostedHermesDashboardCapabilityLoad(home);
		load.applyContext = explicitTestApplyContext(load.manifest);

		try {
			const bootstrap = convergeRuntimeManifest(load, paths);
			expect(bootstrap.installErrors).toEqual([]);
			const bootstrapUnits = readSystemdUnitSnapshot(paths);
			const bootstrapActivation = applySystemdRuntimeUpdate(
				paths,
				{ system: new Map(), user: new Map() },
				bootstrapUnits,
				{},
			);
			expect(bootstrapActivation.applied).toBe(true);
			writeTestRuntimeAppliedState(paths, load, bootstrap, {
				activated: bootstrapActivation.activated,
			});
			const watchPath = parseEnv(readSystemdEnvFile(paths, "clawdi-runtime-watch")).PATH;
			if (watchPath === undefined) throw new Error("watch environment has no PATH");
			const dashboardRevision = systemdEnvDigest(
				readSystemdEnvFile(paths, "clawdi-hermes-dashboard"),
			);

			// Bootstrap and watch are separate processes with the same desired state.
			process.env.PATH = watchPath;
			for (const phase of ["first-watch", "repeat-watch"]) {
				writeFileSync(systemctlLog, "");
				const before = readSystemdUnitSnapshot(paths);
				const convergence = convergeRuntimeManifest(load, paths);
				expect(convergence.installErrors).toEqual([]);
				const after = readSystemdUnitSnapshot(paths);
				const activation = applySystemdRuntimeUpdate(paths, before, after, {});
				expect(activation.applied).toBe(true);
				expect({
					phase,
					watchPath: parseEnv(readSystemdEnvFile(paths, "clawdi-runtime-watch")).PATH,
					units: after,
					dashboardRevision: systemdEnvDigest(readSystemdEnvFile(paths, "clawdi-hermes-dashboard")),
					activated: activation.activated,
					systemUnitsChanged: activation.systemUnitsChanged,
					userUnitsChanged: activation.userUnitsChanged,
					restarts: readFileSync(systemctlLog, "utf8")
						.split("\n")
						.filter((line) => /^(--user )?restart /.test(line)),
				}).toEqual({
					phase,
					watchPath,
					units: bootstrapUnits,
					dashboardRevision,
					activated: bootstrapActivation.activated,
					systemUnitsChanged: [],
					userUnitsChanged: [],
					restarts: [],
				});
				writeTestRuntimeAppliedState(paths, load, convergence, { activated: activation.activated });
			}

			const managed = `${paths.userLocalBin}:${join(home, ".openclaw", "bin")}`;
			process.env.PATH = `/custom bin::./tools:${managed}:/usr/bin:`;
			expect(runtimeSystemdCommonEnvironment(paths).PATH).toBe(
				`${managed}:/custom bin::./tools:/usr/bin`,
			);
			delete process.env.PATH;
			const fallback = `${managed}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
			expect(runtimeSystemdCommonEnvironment(paths).PATH).toBe(fallback);
			process.env.PATH = "";
			expect(runtimeSystemdCommonEnvironment(paths).PATH).toBe(fallback);
		} finally {
			if (inheritedPath === undefined) delete process.env.PATH;
			else process.env.PATH = inheritedPath;
		}
	});

	it("runtime watch advances applied generation on a generation-only manifest update", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const systemctlPath = join(root, "bin", "systemctl");
		const systemctlLog = join(root, "systemctl.log");
		const openclawConfig = join(home, ".openclaw", "openclaw.json");
		const sidecarReadyPath = join(run, "egress", "systemd", "ca.pem");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const previousUmask = process.umask(0o022);
		const logs: string[] = [];
		let generation = 30;
		let manifestEtag = testBundleEtag("manifest-generation-30");
		let daemonToken = "file-runtime-token";
		let gatewayToken: string | undefined = "test-openclaw-gateway-token";
		mkdirSync(join(run, "secrets"), { recursive: true });
		writeFakeSystemdManager({
			path: systemctlPath,
			logPath: systemctlLog,
			stateRoot: join(root, "systemctl-generation-state"),
			sidecarReadyPath,
		});
		writeFakeOpenClawConfigMutationSdk(home);
		seedOfficialOpenClawServiceInstaller(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlPath;
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		setRuntimeApplyContextFixture(
			{
				generation,
				manifestETag: manifestEtag,
				applyReceiptId: "apply-receipt-generation-0030",
				bootNonce: "boot-nonce-generation-0001",
			},
			CANONICAL_TEST_CONTEXT,
		);
		const watchFetch = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: (request) => {
					if (request.headers["if-none-match"]) {
						return new Response(null, { status: 304, headers: { etag: manifestEtag } });
					}
					const payload = hostedRuntimeWatchLocalePayload(home, generation);
					return hostedRuntimeBundleResponse(
						{
							...payload,
							secretValues: {
								...payload.secretValues,
								"secret://clawdi/auth-token": daemonToken,
								...(gatewayToken
									? { "secret://runtime/openclaw/gateway-token": gatewayToken }
									: {}),
							},
						},
						{ etag: manifestEtag, includeRuntimeServiceSecrets: false },
					);
				},
			},
		]);
		const manifestRequests = () =>
			watchFetch.captured.filter((request) => request.path !== "/v1/runtime/vaults");

		try {
			await runtimeWatch({ once: true, json: true });
			const paths = getRuntimePaths();
			const initialAppliedState = readRuntimeAppliedState(paths);
			if (!initialAppliedState) throw new Error(logs.join("\n"));
			expect(initialAppliedState).toMatchObject({
				etag: testBundleEtag("manifest-generation-30"),
				generation: 30,
			});
			const initialDaemonActivation = initialAppliedState.activated["clawdi-daemon.service"];
			expect(initialDaemonActivation).toMatch(/^[a-f0-9]{64}$/);
			expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
				gatewayToken,
			);
			const initialDaemonUnit = readSystemdSystemUnit(paths, "clawdi-daemon");
			const initialDaemonEnv = readSystemdEnvFile(paths, "clawdi-daemon");
			const requestsBeforeMatchingTuple = manifestRequests().length;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(manifestRequests().slice(requestsBeforeMatchingTuple)).toHaveLength(1);
			expect(manifestRequests().at(-1)?.headers["if-none-match"]).toBe(manifestEtag);
			expect(JSON.parse(logs.at(-1) ?? "{}").status).toBe("not_modified");
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");

			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: manifestEtag,
					applyReceiptId: "apply-receipt-generation-0030-refreshed",
					bootNonce: "boot-nonce-generation-0002",
				},
				CANONICAL_TEST_CONTEXT,
			);
			const requestsBeforeTupleRefresh = manifestRequests().length;
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(manifestRequests().slice(requestsBeforeTupleRefresh)).toHaveLength(2);
			expect(
				manifestRequests()
					.slice(requestsBeforeTupleRefresh)
					.map((request) => request.headers["if-none-match"] ?? null),
			).toEqual([manifestEtag, null]);
			expect(readRuntimeAppliedState(paths)).toMatchObject({
				generation: 30,
				manifestETag: manifestEtag,
				applyReceiptId: "apply-receipt-generation-0030-refreshed",
				bootNonce: "boot-nonce-generation-0002",
			});
			expect(readFileSync(systemctlLog, "utf-8")).not.toMatch(
				/(?:^|\s)(?:daemon-reload|start|restart|stop|enable|disable|reset-failed)(?:\s|$)/m,
			);

			const committedBeforeMismatchedGeneration = readFileSync(paths.appliedState, "utf-8");
			writeFileSync(systemctlLog, "");
			setRuntimeApplyContextFixture(
				{
					generation: 31,
					manifestETag: '"hosted-control-plane-generation-31"',
					applyReceiptId: "apply-receipt-generation-0031",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({
				status: "error",
				mode: "manifest-rejected",
			});
			expect(JSON.parse(logs.at(-1) ?? "{}").error).toContain(
				"runtime apply identity generation 31 does not match resolved manifest apply generation 30",
			);
			expect(readFileSync(paths.appliedState, "utf-8")).toBe(committedBeforeMismatchedGeneration);
			expect(readFileSync(systemctlLog, "utf-8")).toBe("");

			generation = 31;
			manifestEtag = testBundleEtag("manifest-generation-31");
			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: '"hosted-control-plane-generation-31"',
					applyReceiptId: "apply-receipt-generation-0031",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });
			expect(process.exitCode ?? 0).toBe(0);
			expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({
				status: "applied",
				generation: 31,
				etag: testBundleEtag("manifest-generation-31"),
			});
			expect(readRuntimeAppliedState(getRuntimePaths())).toMatchObject({
				etag: testBundleEtag("manifest-generation-31"),
				generation: 31,
				manifestETag: '"hosted-control-plane-generation-31"',
				applyReceiptId: "apply-receipt-generation-0031",
				bootNonce: "boot-nonce-generation-0001",
			});

			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: manifestEtag,
					applyReceiptId: "apply-receipt-generation-0031",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			const event = JSON.parse(logs.at(-1) ?? "{}");
			expect(event.status).toBe("applied");
			expect(event.generation).toBe(31);
			expect(event.etag).toBe(manifestEtag);
			expect(readRuntimeAppliedState(getRuntimePaths())).toMatchObject({
				etag: testBundleEtag("manifest-generation-31"),
				generation: 31,
				manifestETag: manifestEtag,
				applyReceiptId: "apply-receipt-generation-0031",
				bootNonce: "boot-nonce-generation-0001",
			});
			expect(manifestRequests()).toHaveLength(10);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"--user restart openclaw-gateway.service",
			);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain("restart clawdi-daemon.service");
			const committedBeforeTokenRotation = readFileSync(paths.appliedState, "utf-8");

			writeFileSync(systemctlLog, "");
			process.env.CLAWDI_AUTH_TOKEN = "stale-process-auth-token";
			process.env.STALE_RUNTIME_AUTH_TOKEN = "stale-selected-auth-token";
			process.env.OPENCLAW_GATEWAY_TOKEN = "stale-process-gateway-token";
			generation = 32;
			manifestEtag = testBundleEtag("manifest-generation-32");
			daemonToken = "rotated-runtime-auth-token";
			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: manifestEtag,
					applyReceiptId: "apply-receipt-generation-0032",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			const rotatedAppliedState = readRuntimeAppliedState(paths);
			expect(rotatedAppliedState).toMatchObject({
				generation: 32,
				manifestETag: manifestEtag,
				bootNonce: "boot-nonce-generation-0001",
			});
			const rotatedDaemonActivation = rotatedAppliedState?.activated["clawdi-daemon.service"];
			expect(rotatedDaemonActivation).toMatch(/^[a-f0-9]{64}$/);
			expect(rotatedDaemonActivation).not.toBe(initialDaemonActivation);
			expect(manifestRequests().at(-1)?.headers.authorization).toBe("Bearer file-runtime-token");
			expect(readFileSync(join(run, "secrets", "auth-token"), "utf-8")).toBe(
				"rotated-runtime-auth-token\n",
			);
			expect(readFileSync(systemctlLog, "utf-8")).toContain("restart clawdi-daemon.service");
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"--user restart openclaw-gateway.service",
			);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain(
				"restart clawdi-runtime-sidecar.service",
			);
			expect(readSystemdSystemUnit(paths, "clawdi-daemon")).toBe(initialDaemonUnit);
			const rotatedDaemonEnv = readSystemdEnvFile(paths, "clawdi-daemon");
			expect(rotatedDaemonEnv).not.toBe(initialDaemonEnv);
			expect(rotatedDaemonEnv).not.toContain("rotated-runtime-auth-token");
			expect(rotatedDaemonEnv).toMatch(/^CLAWDI_MANAGED_CONTENT_DIGEST="[a-f0-9]{32}"$/m);

			// Simulate a crash after the desired token file and rendered environment were
			// written but before the activated hash advanced.
			writeFileSync(paths.appliedState, committedBeforeTokenRotation);
			writeFileSync(systemctlLog, "");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });
			expect(process.exitCode ?? 0).toBe(0);
			expect(
				readFileSync(systemctlLog, "utf-8")
					.trim()
					.split("\n")
					.filter((call) => call === "restart clawdi-daemon.service"),
			).toHaveLength(1);
			expect(readSystemdSystemUnit(paths, "clawdi-daemon")).toBe(initialDaemonUnit);
			expect(readRuntimeAppliedState(paths)?.activated["clawdi-daemon.service"]).toBe(
				rotatedDaemonActivation,
			);

			writeFileSync(systemctlLog, "");
			generation = 33;
			manifestEtag = testBundleEtag("manifest-generation-33");
			gatewayToken = "rotated-projected-gateway-token";
			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: manifestEtag,
					applyReceiptId: "apply-receipt-generation-0033",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode ?? 0).toBe(0);
			expect(readRuntimeAppliedState(getRuntimePaths())).toMatchObject({
				generation: 33,
				manifestETag: manifestEtag,
				bootNonce: "boot-nonce-generation-0001",
			});
			expect(readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway")).not.toContain(
				"OPENCLAW_GATEWAY_TOKEN",
			);
			expect(readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway")).not.toContain(
				"rotated-projected-gateway-token",
			);
			expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
				"rotated-projected-gateway-token",
			);
			expect(readFileSync(systemctlLog, "utf-8")).toContain(
				"--user restart openclaw-gateway.service",
			);
			expect(readFileSync(systemctlLog, "utf-8")).not.toContain("restart clawdi-daemon.service");

			writeFileSync(systemctlLog, "");
			generation = 34;
			manifestEtag = testBundleEtag("manifest-generation-34");
			gatewayToken = undefined;
			setRuntimeApplyContextFixture(
				{
					generation,
					manifestETag: manifestEtag,
					applyReceiptId: "apply-receipt-generation-0034",
					bootNonce: "boot-nonce-generation-0001",
				},
				CANONICAL_TEST_CONTEXT,
			);
			const tokenPath = join(run, "secrets", "auth-token");
			const fixedTokenTime = new Date("2026-07-30T00:00:00.000Z");
			utimesSync(tokenPath, fixedTokenTime, fixedTokenTime);
			const tokenBeforeRejection = readFileSync(tokenPath, "utf-8");
			const tokenMtimeBeforeRejection = statSync(tokenPath).mtimeMs;
			const appliedStateBeforeRejection = readFileSync(paths.appliedState, "utf-8");
			process.exitCode = undefined;
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			expect(JSON.parse(logs.at(-1) ?? "{}")).toMatchObject({
				status: "error",
				stage: "final",
			});
			expect(JSON.parse(logs.at(-1) ?? "{}").error).toContain(
				"Runtime secret secret://runtime/openclaw/gateway-token is unavailable.",
			);
			expect(readRuntimeAppliedState(getRuntimePaths())?.generation).toBe(33);
			expect(readFileSync(tokenPath, "utf-8")).toBe(tokenBeforeRejection);
			expect(statSync(tokenPath).mtimeMs).toBe(tokenMtimeBeforeRejection);
			expect(readFileSync(paths.appliedState, "utf-8")).toBe(appliedStateBeforeRejection);
			// Rejected credentials may trigger read-only preflight inspection, but
			// must not change units, secrets or committed authority.
			expect(
				readFileSync(systemctlLog, "utf-8")
					.trim()
					.split("\n")
					.filter((call) => call && !/^(?:--user )?(?:show|is-enabled)(?: |$)/.test(call)),
			).toEqual([]);
		} finally {
			watchFetch.restore();
			console.log = previousLog;
			process.umask(previousUmask);
			process.exitCode = previousExitCode;
		}
	});

	it.each([
		[304, false],
		[200, true],
		[200, false],
	] as const)(
		"runtime watch preserves conditional manifest %s behavior with hot apply %s",
		async (responseStatus, hotApply) => {
			installSuccessfulSystemctlFixture();
			const home = join(root, "home", "clawdi");
			const state = join(root, "var", "lib", "clawdi");
			const run = join(root, "run", "clawdi");
			const bin = join(root, "bin");
			const openclawBin = join(home, ".local", "bin", "openclaw");
			const previousExitCode = process.exitCode;
			const previousLog = console.log;
			const logs: string[] = [];
			const providerSecretRef = "secret://provider.default.apiKey";
			const channelSecretRef = "secret://channels/telegram/clawdi_accttelegram/agent-token";
			const channelPlaceholderSecretRef =
				"secret://channels/telegram/clawdi_accttelegram/placeholder-token";
			const hostedPayload = {
				schemaVersion: "clawdi.hosted-runtime.bundle.v2",
				sourceRevision: "d".repeat(64),
				manifest: {
					schemaVersion: "clawdi.hosted-runtime.manifest.v1",
					runtime: "openclaw",
					deploymentId: "dep_watch_secret",
					environmentId: "env_watch_secret",
					...hostedRequiredState(),
					instanceId: "iid_watch_secret",
					generation: 22,
					issuedAt: "2026-06-06T00:00:00Z",
					locale: TEST_HOSTED_LOCALE,
					system: hostedSystemFixture(home),
					controlPlane: { cloudApiUrl: "https://cloud-api.test" },
					clawdiCli: {
						source: "npm:clawdi",
						packageSpec: TEST_RUNNING_CLI_SPEC,
						registry: "https://registry.npmjs.org",
					},
					runtimes: {
						openclaw: hostedOpenClawRuntime({
							provider_ids: ["clawdi-managed-v2"],
							primary_model: {
								provider_id: "clawdi-managed-v2",
								model: "gpt-5.5",
							},
						}),
					},
					providers: {
						"clawdi-managed-v2": {
							kind: "openai-compatible",
							type: "custom_openai_compatible",
							baseUrl: "https://sub2api.test/v1",
							models: [{ id: "gpt-5.5" }],
							apiMode: "openai_chat",
							managed_by: "clawdi",
							runtimeEnvName: "CLAWDI_AI_API_KEY",
							apiKeySecretRef: providerSecretRef,
						},
					},
				},
				channelBindings: [
					{
						provider: "telegram",
						accountKey: "clawdi_accttelegram",
						agentTokenSecretRef: channelSecretRef,
						placeholderTokenSecretRef: channelPlaceholderSecretRef,
					},
				],
				secretValues: {
					...TEST_RUNTIME_SERVICE_SECRET_VALUES,
					...TEST_HOSTED_CODEX_SECRET_VALUES,
					[providerSecretRef]: "sk-provider-watch",
					[channelSecretRef]: "agent-token-watch",
					[channelPlaceholderSecretRef]: "999999999:54db03c2296520629c70cfb6e3b15f8e",
				},
			};
			const stableBundleEtag = `"sha256:${hostedPayload.sourceRevision}"`;
			const manifestResponse = () =>
				new Response(JSON.stringify(hostedPayload), {
					status: 200,
					headers: {
						"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
						etag: stableBundleEtag,
					},
				});

			mkdirSync(join(run, "secrets"), { recursive: true });
			mkdirSync(bin, { recursive: true });
			mkdirSync(dirname(openclawBin), { recursive: true });
			writeOpenClawConfigMutationFixture(home);
			writeFileSync(
				openclawBin,
				`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
${fakeOpenClawConfigSchemaCommand()}
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >/dev/null
  exit 0
fi
printf 'unexpected openclaw command: %s\\n' "$*" >&2
exit 64
`,
			);
			chmodSync(openclawBin, 0o700);
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
			process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
			process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
				join(root, "watch-provider-auth"),
				join(root, "watch-provider-auth", "calls.log"),
			);
			process.exitCode = undefined;
			writeCanonicalApplyContext(
				{
					generation: 22,
					manifestETag: stableBundleEtag,
					applyReceiptId: "test-apply-receipt-0022",
					bootNonce: "test-boot-nonce-000022",
				},
				CANONICAL_TEST_CONTEXT,
			);
			console.log = (value?: unknown) => {
				logs.push(String(value));
			};
			seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
			writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
			const paths = getRuntimePaths();
			seedMitmproxyCache(paths);
			const initial = mockFetch([
				{ method: "GET", path: "/v1/runtime/manifest", response: () => manifestResponse() },
			]);
			try {
				const manifestLoad = await loadRemoteRuntimeManifest(paths);
				if (!("manifest" in manifestLoad) || "notModified" in manifestLoad) {
					throw new Error("expected initial manifest load success");
				}
				const projected = applyRuntimeBundleChannelsToManifestLoad(manifestLoad);
				const initialConvergence = convergeRuntimeManifest(projected, paths);
				cacheRuntimeLastGoodManifest(
					projected.sourceBundle,
					paths,
					projected.secretValues,
					projected.manifest,
				);
				expect(initialConvergence.installErrors).toEqual([]);
				expectEgressProfileBundleUsesSecretRef(
					initialConvergence.outputs.egressProfileBundle,
					"secret://provider.default.apiKey",
					"sk-provider-watch",
				);
				mkdirSync(dirname(paths.appliedState), { recursive: true });
				writeFileSync(
					paths.appliedState,
					JSON.stringify({
						schemaVersion: "clawdi.runtimeAppliedState.v2",
						appliedAt: "2026-07-13T00:00:00.000Z",
						instanceId: "iid_watch_secret",
						etag: stableBundleEtag,
						sourceRevision: "d".repeat(64),
						generation: 22,
						applyGeneration: 22,
						manifestETag: stableBundleEtag,
						applyReceiptId: "test-apply-receipt-0022",
						bootNonce: "test-boot-nonce-000022",
						contentIdentity: {
							sourcePath: "https://runtime.test/v1/runtime/manifest",
							sha256: runtimeAppliedContentIdentity(projected).sha256,
						},
						activated: {},
						providerIds: ["clawdi-managed-v2"],
						projectedProviderIds: { openclaw: ["clawdi-managed-v2"] },
					}),
				);
			} finally {
				initial.restore();
			}
			// Emulate an upgrade from 0.14.82: only its exact legacy pair survives.
			const legacy = legacyRuntimeManifestPaths(paths);
			for (const [current, old] of [
				[paths.manifestLastGood, legacy.manifestLastGood],
				[paths.managedSecretCacheFile, legacy.managedSecretCacheFile],
			]) {
				copyFileSync(current, old);
				rmSync(current);
			}
			rmSync(dirname(paths.manifestLastGood), { recursive: true, force: true });
			const baselineAuthority = readFileSync(paths.appliedState, "utf8");
			const baselineRevision = systemdEnvDigest(readSystemdEnvFile(paths, "openclaw-gateway"));
			const baselineMitmSecrets = JSON.parse(
				readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8"),
			);
			expect(baselineMitmSecrets["secret://provider.default.apiKey"]).toBe("sk-provider-watch");
			expect(baselineMitmSecrets[channelSecretRef]).toBe("agent-token-watch");

			if (hotApply) process.env.CLAWDI_RUNTIME_OPENCLAW_HOT_APPLY = "1";
			const watchFetch = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: (request) =>
						request.headers["if-none-match"] && responseStatus === 304
							? new Response(null, {
									status: 304,
									headers: { etag: stableBundleEtag },
								})
							: manifestResponse(),
				},
			]);

			try {
				await runtimeWatch({ once: true, json: true });

				if (process.exitCode !== undefined && process.exitCode !== 0) {
					throw new Error(logs.join("\n"));
				}
				expect(watchFetch.captured.map((request) => request.path)).toEqual([
					"/v1/runtime/manifest",
					"/v1/runtime/vaults",
				]);
				expect(watchFetch.captured[0].headers["if-none-match"]).toBe(stableBundleEtag);
				const event = JSON.parse(logs[0]);
				expect(event.status).toBe(responseStatus === 200 && !hotApply ? "applied" : "not_modified");
				expect(readFileSync(paths.manifestLastGood, "utf8")).toBe(
					readFileSync(legacy.manifestLastGood, "utf8"),
				);
				expect(readFileSync(paths.managedSecretCacheFile, "utf8")).toBe(
					readFileSync(legacy.managedSecretCacheFile, "utf8"),
				);
				if (responseStatus === 200 && !hotApply)
					expect(readFileSync(paths.appliedState, "utf8")).not.toBe(baselineAuthority);
				else expect(readFileSync(paths.appliedState, "utf8")).toBe(baselineAuthority);
				expect(event.generation).toBe(22);
				expect(event.etag).toBe(stableBundleEtag);
				expect(readRuntimeAppliedState(paths)).toMatchObject({
					schemaVersion: "clawdi.runtimeAppliedState.v2",
					etag: stableBundleEtag,
					sourceRevision: "d".repeat(64),
					generation: 22,
					providerIds: ["clawdi-managed-v2"],
				});
				expect(event.systemdUnitsChanged).toBeUndefined();
				expect(event.systemdApply).toBeUndefined();
				const egressSecrets = JSON.parse(
					readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8"),
				);
				expect(egressSecrets["secret://provider.default.apiKey"]).toBe("sk-provider-watch");
				expect(egressSecrets[channelSecretRef]).toBe("agent-token-watch");
				expect(systemdEnvDigest(readSystemdEnvFile(paths, "openclaw-gateway"))).toBe(
					baselineRevision,
				);
				// Re-run the same 304 with exact legacy history but a blocked durable destination.
				rmSync(dirname(paths.manifestLastGood), { recursive: true, force: true });
				writeFileSync(dirname(paths.manifestLastGood), "blocked", { mode: 0o600 });
				logs.length = 0;
				await runtimeWatch({ once: true, json: true });
				const failed = JSON.parse(logs[0]);
				expect(failed.status).toBe("error");
				expect(JSON.stringify(failed)).toContain(
					"could not persist verified committed runtime snapshot",
				);
				if (responseStatus === 200 && !hotApply)
					expect(readFileSync(paths.appliedState, "utf8")).not.toBe(baselineAuthority);
				else expect(readFileSync(paths.appliedState, "utf8")).toBe(baselineAuthority);
			} finally {
				watchFetch.restore();
				console.log = previousLog;
				process.exitCode = previousExitCode;
			}
		},
	);

	it("runtime watch retries datasource failures and applies after recovery", async () => {
		installSuccessfulSystemctlFixture();
		setRuntimeApplyGeneration(18, CANONICAL_TEST_CONTEXT);
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		const runOnce = async (
			manifestResponse: () => Response | Promise<Response>,
			expectedStatus: "error" | "applied",
		) => {
			process.exitCode = undefined;
			logs.length = 0;
			const { restore } = mockFetch([
				{ method: "GET", path: "/v1/runtime/manifest", response: manifestResponse },
			]);
			try {
				setRuntimeApplyGeneration(18, CANONICAL_TEST_CONTEXT);
				await runtimeWatch({ once: true, json: true });
			} finally {
				restore();
			}
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe(expectedStatus);
			return event;
		};

		try {
			await runOnce(() => {
				throw new Error("network down");
			}, "error");
			await runOnce(() => new Response("upstream unavailable", { status: 503 }), "error");
			await runOnce(
				() =>
					new Response("{", {
						status: 200,
						headers: {
							"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
							etag: testBundleEtag("malformed-bundle"),
						},
					}),
				"error",
			);
			const recovered = await runOnce(
				() =>
					hostedRuntimeBundleResponse(
						{
							manifest: {
								schemaVersion: "clawdi.hosted-runtime.manifest.v1",
								runtime: "openclaw",
								deploymentId: "dep_watch_recovery",
								environmentId: "env_watch_recovery",
								...hostedRequiredState(),
								instanceId: "iid_watch_recovery",
								generation: 18,
								issuedAt: "2026-06-06T00:00:00Z",
								locale: TEST_HOSTED_LOCALE,
								system: hostedSystemFixture(home),
								controlPlane: { cloudApiUrl: "https://cloud-api.test" },
								clawdiCli: {
									source: "npm:clawdi",
									packageSpec: TEST_RUNNING_CLI_SPEC,
									registry: "https://registry.npmjs.org",
								},
								runtimes: { openclaw: hostedOpenClawRuntime() },
							},
							secretValues: {},
						},
						{ etag: testBundleEtag("etag-recovered") },
					),
				"applied",
			);

			expect(recovered.generation).toBe(18);
			expect(readRuntimeAppliedState(getRuntimePaths())?.etag).toBe(
				testBundleEtag("etag-recovered"),
			);
			expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
		} finally {
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("runtime watch reports deploy-key authentication failures in observed state", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(join(run, "secrets", "auth-token"), "revoked-runtime-token\n");
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () => new Response("revoked", { status: 401 }),
			},
		]);

		try {
			await runtimeWatch({ once: true, json: true });

			expect(process.exitCode).toBe(1);
			const event = JSON.parse(logs[0]);
			expect(event.status).toBe("error");
			expect(event.stage).toBe("auth");
			expect(event.error).toContain("authentication failed: HTTP 401");
			const observed = await readHostedRuntimeObserved(getRuntimePaths());
			expect(observed?.status).toBe("error");
			expect(observed?.convergeError).toContain("authentication failed: HTTP 401");
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});
});
