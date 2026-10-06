import { describe, expect, it } from "bun:test";

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";

import { writeRuntimeAppliedState } from "../src/runtime/applied-state";

import { readHostedRuntimeObserved } from "../src/runtime/observed";

import { getRuntimePaths } from "../src/runtime/paths";

import {
	buildRuntimeBootStatus,
	writeRuntimeBootStatus,
	writeRuntimeWatchStatus,
} from "../src/runtime/state";

import { GENERATED_RUNTIME_SYSTEMD_FILE_HEADER } from "../src/runtime/systemd-user";

import {
	fakeSystemdStatePath,
	hostedCliManifestResponse,
	installRuntimeTestHooks,
	installSuccessfulSystemctlFixture,
	root,
	startHealthyOpenClawGateway,
	TEST_PROCESS_USER,
	TEST_RUNNING_CLI_SPEC,
	testBundleEtag,
	writeOpenClawConfigMutationFixture,
} from "../src/test-support/runtime-harness";

installRuntimeTestHooks();

describe("runtime manifest datasource", () => {
	it("runtime observed samples systemd unit health", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousPath = process.env.PATH;
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
		const longJournalLine = `Gateway startup failed: ${"x".repeat(600)}`;
		writeFileSync(
			join(bin, "systemctl"),
			`#!/usr/bin/env bash
unit=""
if [ "\${1:-}" = "--user" ]; then
  unit="\${3:-}"
else
  unit="\${2:-}"
fi
case "$unit" in
  clawdi-runtime-watch.service|clawdi-daemon.service)
    printf 'ActiveState=active\\nSubState=running\\n'
    ;;
  clawdi-files.service)
    printf 'ActiveState=failed\\nSubState=failed\\nResult=exit-code\\nExecMainCode=exited\\nExecMainStatus=78\\n'
    ;;
  openclaw-gateway.service)
    printf 'ActiveState=failed\\nSubState=failed\\nResult=exit-code\\nExecMainCode=exited\\nExecMainStatus=1\\n'
    ;;
  *)
    printf 'ActiveState=inactive\\nSubState=dead\\n'
    ;;
esac
`,
		);
		chmodSync(join(bin, "systemctl"), 0o700);
		writeFileSync(
			join(bin, "journalctl"),
			`#!/usr/bin/env bash
case "$*" in
  *clawdi-files.service*) printf 'OPENAI_API_KEY=sk-must-not-leak\\n' ;;
  *openclaw-gateway.service*) printf '\\033[31m%s\\033[0m\\nignored second line\\n' '${longJournalLine}' ;;
esac
		`,
		);
		chmodSync(join(bin, "journalctl"), 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		mkdirSync(getRuntimePaths().cacheRoot, { recursive: true });
		process.env.CLAWDI_SYSTEMCTL_PATH = join(bin, "systemctl");
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		mkdirSync(paths.systemdUserRoot, { recursive: true });
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"), "[Service]\n");
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-daemon.service"), "[Service]\n");
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-files.service"), "[Service]\n");
		writeFileSync(
			join(paths.systemdUserRoot, "openclaw-gateway.service"),
			`${GENERATED_RUNTIME_SYSTEMD_FILE_HEADER}\n[Service]\n`,
		);
		writeRuntimeBootStatus(
			buildRuntimeBootStatus(
				{
					mode: "normal",
					status: "ok",
					stage: "final",
					bootId: "boot-systemd",
					runtimeMode: "hosted",
					activeGeneration: 9,
					instanceId: "iid-systemd",
					enabledRuntimes: ["openclaw"],
					errors: [],
					exitCode: 0,
					datasource: "RuntimeSource",
					hostPolicy: {
						path: paths.hostPolicy,
						exists: true,
						valid: true,
						mode: "hosted",
					},
				},
				paths,
			),
			paths,
		);
		writeRuntimeWatchStatus({ status: "applied", generation: 9, instanceId: "iid-systemd" }, paths);

		try {
			const observed = await readHostedRuntimeObserved(paths);

			expect(observed?.status).toBe("error");
			expect(observed?.systemd).toEqual({
				status: "error",
				unitCount: 4,
				units: [
					{
						scope: "system",
						name: "clawdi-daemon.service",
						activeState: "active",
						subState: "running",
						status: "ok",
						error: null,
					},
					{
						scope: "system",
						name: "clawdi-files.service",
						activeState: "failed",
						subState: "failed",
						status: "error",
						error: "Result=exit-code; ExecMainCode=exited; ExecMainStatus=78",
					},
					{
						scope: "system",
						name: "clawdi-runtime-watch.service",
						activeState: "active",
						subState: "running",
						status: "ok",
						error: null,
					},
					{
						scope: "user",
						name: "openclaw-gateway.service",
						activeState: "failed",
						subState: "failed",
						status: "error",
						error: longJournalLine.slice(0, 500),
					},
				],
			});
			expect(JSON.stringify(observed)).not.toContain("sk-must-not-leak");
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime observed keeps runtime-watch auto-restart outside data-plane readiness", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const watchFailed = join(root, "watch-failed");
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
		const systemctl = join(bin, "systemctl");
		writeFileSync(
			systemctl,
			`#!/usr/bin/env bash
if [ -f '${watchFailed}' ]; then
  printf 'ActiveState=failed\\nSubState=failed\\n'
else
  printf 'ActiveState=activating\\nSubState=auto-restart\\n'
fi
`,
		);
		chmodSync(systemctl, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"), "[Service]\n");
		writeRuntimeWatchStatus(
			{ status: "applied", generation: 5, instanceId: "iid-watch-restart" },
			paths,
		);
		const appliedState = {
			schemaVersion: "clawdi.runtimeAppliedState.v2" as const,
			appliedAt: "2026-08-12T04:21:24.000Z",
			instanceId: "iid-watch-restart",
			etag: '"watch-restart"',
			sourceRevision: "a".repeat(64),
			generation: 5,
			contentIdentity: {
				sourcePath: "https://runtime.test/v1/runtime/manifest",
				sha256: "b".repeat(64),
			},
			activated: {},
			providerIds: [],
			projectedProviderIds: {},
		};

		writeRuntimeAppliedState(appliedState, paths);
		const restarting = await readHostedRuntimeObserved(paths, { appliedState });

		expect(restarting?.status).toBe("ok");
		expect(restarting?.systemd).toEqual({
			status: "unknown",
			unitCount: 1,
			units: [
				{
					scope: "system",
					name: "clawdi-runtime-watch.service",
					activeState: "activating",
					subState: "auto-restart",
					status: "unknown",
					error: null,
				},
			],
		});

		writeFileSync(watchFailed, "");
		const failed = await readHostedRuntimeObserved(paths, { appliedState });
		expect(failed?.status).toBe("error");
		expect(failed?.systemd).toMatchObject({
			status: "error",
			units: [{ name: "clawdi-runtime-watch.service", status: "error" }],
		});
	});

	it("runtime observed does not report ok when managed systemd units are inactive", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousPath = process.env.PATH;
		mkdirSync(home, { recursive: true });
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
		const systemctl = join(bin, "systemctl");
		writeFileSync(
			systemctl,
			`#!/usr/bin/env bash
printf 'ActiveState=inactive\\nSubState=dead\\n'
`,
		);
		chmodSync(systemctl, 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		mkdirSync(getRuntimePaths().cacheRoot, { recursive: true });
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"), "[Service]\n");
		writeRuntimeBootStatus(
			buildRuntimeBootStatus(
				{
					mode: "normal",
					status: "ok",
					stage: "final",
					bootId: "boot-systemd-inactive",
					runtimeMode: "hosted",
					activeGeneration: 9,
					instanceId: "iid-systemd-inactive",
					enabledRuntimes: ["openclaw"],
					errors: [],
					exitCode: 0,
					datasource: "RuntimeSource",
					hostPolicy: {
						path: paths.hostPolicy,
						exists: true,
						valid: true,
						mode: "hosted",
					},
				},
				paths,
			),
			paths,
		);
		writeRuntimeWatchStatus(
			{ status: "applied", generation: 9, instanceId: "iid-systemd-inactive" },
			paths,
		);

		try {
			const observed = await readHostedRuntimeObserved(paths);

			expect(observed?.status).toBe("unknown");
			expect(observed?.systemd).toMatchObject({
				status: "unknown",
				unitCount: 2,
				units: [
					{
						scope: "system",
						name: "clawdi-runtime-watch.service",
						activeState: "inactive",
						status: "unknown",
					},
					{
						scope: "user",
						name: "openclaw-gateway.service",
						activeState: "inactive",
						status: "unknown",
					},
				],
			});
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime observed ignores volatile watch timestamps and running uptimes", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const bin = join(root, "bin");
		const previousPath = process.env.PATH;
		mkdirSync(run, { recursive: true });
		mkdirSync(bin, { recursive: true });
		const systemctl = join(bin, "systemctl");
		writeFileSync(
			systemctl,
			`#!/usr/bin/env bash
printf 'ActiveState=active\\nSubState=running\\n'
`,
		);
		chmodSync(systemctl, 0o700);
		process.env.PATH = `${bin}:${previousPath ?? ""}`;
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		mkdirSync(getRuntimePaths().cacheRoot, { recursive: true });
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctl;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(paths.systemdSystemRoot, { recursive: true });
		writeFileSync(join(paths.systemdSystemRoot, "clawdi-runtime-watch.service"), "[Service]\n");
		writeRuntimeWatchStatus(
			{ status: "applied", generation: 9, instanceId: "iid-observed-stable" },
			paths,
		);

		try {
			const first = await readHostedRuntimeObserved(paths);
			writeRuntimeWatchStatus(
				{ status: "applied", generation: 9, instanceId: "iid-observed-stable" },
				paths,
			);
			const second = await readHostedRuntimeObserved(paths);
			const stable = (value: Record<string, unknown> | null) => {
				if (!value) return value;
				const copy = { ...value };
				delete copy.reportedAt;
				return copy;
			};

			expect(stable(second)).toEqual(stable(first));
			expect(second?.watch).not.toHaveProperty("timestamp");
			expect(second?.systemd).toEqual({
				status: "ok",
				unitCount: 1,
				units: [
					{
						scope: "system",
						name: "clawdi-runtime-watch.service",
						activeState: "active",
						subState: "running",
						status: "ok",
						error: null,
					},
				],
			});
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it("runtime observed reports provider secret health without leaking secret values", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(join(run, "secrets"), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		installSuccessfulSystemctlFixture();
		writeFileSync(
			fakeSystemdStatePath(
				join(root, "systemctl-success-state"),
				"user",
				"openclaw-gateway.service",
				"active",
			),
			"",
		);
		writeOpenClawConfigMutationFixture(home, { gateway: startHealthyOpenClawGateway() });
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
		const cached = hostedCliManifestResponse(home, TEST_RUNNING_CLI_SPEC);
		Object.assign(cached.manifest, {
			deploymentId: "dep-provider-observed",
			environmentId: "env-provider-observed",
			instanceId: "iid-provider-observed",
			generation: 9,
			providers: {
				default: {
					kind: "openai-compatible",
					type: "custom_openai_compatible",
					baseUrl: "https://sub2api.test/v1",
					models: [{ id: "gpt-5.5" }],
					apiMode: "openai_responses",
					managed_by: "user",
					runtimeEnvName: "OPENAI_API_KEY",
					apiKeySecretRef: "secret://provider.default.apiKey",
				},
			},
		});
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify({
				schemaVersion: "clawdi.hosted-runtime.bundle.v2",
				sourceRevision: "a".repeat(64),
				manifest: cached.manifest,
				channelBindings: [],
				secretValues: {},
			}),
		);
		writeFileSync(
			join(run, "secrets", "egress-secrets.json"),
			JSON.stringify({ "secret://provider.default.apiKey": "sk-observed-provider" }),
		);
		writeRuntimeBootStatus(
			buildRuntimeBootStatus(
				{
					mode: "normal",
					status: "ok",
					stage: "final",
					bootId: "boot-provider",
					runtimeMode: "hosted",
					activeGeneration: 9,
					instanceId: "iid-provider-observed",
					enabledRuntimes: ["openclaw"],
					errors: [],
					exitCode: 0,
					datasource: "RuntimeSource",
					hostPolicy: {
						path: paths.hostPolicy,
						exists: true,
						valid: true,
						mode: "hosted",
					},
				},
				paths,
			),
			paths,
		);
		writeRuntimeAppliedState(
			{
				schemaVersion: "clawdi.runtimeAppliedState.v2",
				appliedAt: "2026-07-13T06:00:00.000Z",
				instanceId: "iid-provider-observed",
				etag: testBundleEtag("provider-observed"),
				sourceRevision: "a".repeat(64),
				generation: 9,
				contentIdentity: {
					sourcePath: "https://runtime.test/v1/runtime/manifest",
					sha256: "b".repeat(64),
				},
				activated: {},
				providerIds: ["default"],
				projectedProviderIds: {},
			},
			paths,
		);

		const observed = await readHostedRuntimeObserved(paths);

		expect(observed?.status).toBe("ok");
		expect(observed?.providers).toEqual({
			default: {
				status: "ok",
				configured: true,
				kind: "openai-compatible",
				baseUrl: "https://sub2api.test/v1",
				model: null,
				models: [{ id: "gpt-5.5" }],
				apiKeySecretRef: "secret://provider.default.apiKey",
				secretAvailable: true,
				reasons: [],
			},
		});
		expect(JSON.stringify(observed)).not.toContain("sk-observed-provider");
	});

	it("runtime observed marks provider health error when its secret ref is unavailable", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(run, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		mkdirSync(paths.serviceStateRoot, { recursive: true });
		mkdirSync(dirname(paths.manifestLastGood), { recursive: true });
		const cached = hostedCliManifestResponse(home, TEST_RUNNING_CLI_SPEC);
		Object.assign(cached.manifest, {
			deploymentId: "dep-provider-missing-secret",
			environmentId: "env-provider-missing-secret",
			instanceId: "iid-provider-missing-secret",
			generation: 10,
			providers: {
				default: {
					kind: "openai-compatible",
					type: "custom_openai_compatible",
					baseUrl: "https://sub2api.test/v1",
					apiMode: "openai_responses",
					managed_by: "user",
					runtimeEnvName: "OPENAI_API_KEY",
					apiKeySecretRef: "secret://provider.default.apiKey",
				},
			},
		});
		writeFileSync(
			paths.manifestLastGood,
			JSON.stringify({
				schemaVersion: "clawdi.hosted-runtime.bundle.v2",
				sourceRevision: "c".repeat(64),
				manifest: cached.manifest,
				channelBindings: [],
				secretValues: {},
			}),
		);
		writeRuntimeBootStatus(
			buildRuntimeBootStatus(
				{
					mode: "normal",
					status: "ok",
					stage: "final",
					bootId: "boot-provider-missing-secret",
					runtimeMode: "hosted",
					activeGeneration: 10,
					instanceId: "iid-provider-missing-secret",
					enabledRuntimes: ["openclaw"],
					errors: [],
					exitCode: 0,
					datasource: "RuntimeSource",
					hostPolicy: {
						path: paths.hostPolicy,
						exists: true,
						valid: true,
						mode: "hosted",
					},
				},
				paths,
			),
			paths,
		);

		const observed = await readHostedRuntimeObserved(paths);

		expect(observed?.status).toBe("error");
		expect(observed?.providers).toEqual({
			default: {
				status: "error",
				configured: true,
				kind: "openai-compatible",
				baseUrl: "https://sub2api.test/v1",
				model: null,
				apiKeySecretRef: "secret://provider.default.apiKey",
				secretAvailable: false,
				reasons: ["model_missing", "secret_missing"],
			},
		});
	});
});
