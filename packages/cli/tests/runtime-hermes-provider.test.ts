import { describe, expect, it } from "bun:test";

import { randomUUID } from "node:crypto";

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { dirname, join } from "node:path";

import { hostedManifestEgressProfiles } from "../src/runtime/hosted-egress-profiles";

import type { RuntimeManifestLoad } from "../src/runtime/manifest-source";

import { getRuntimePaths } from "../src/runtime/paths";

import {
	applySystemdRuntimeUpdate,
	readSystemdUnitSnapshot,
} from "../src/runtime/systemd-transaction";

import {
	convergeRuntimeManifest,
	expectRecord,
	fakeSystemdStatePath,
	hermesModelProviderPluginDir,
	hostedHermesProviderLoad,
	hostedSingleProviderModeLoad,
	installRuntimeTestHooks,
	readHermesConfigYaml,
	readSystemdEnvFile,
	root,
	seedFakeSystemdSnapshotProcesses,
	systemdEnvDigest,
	TEST_PROCESS_USER,
	writeFakeSystemdManager,
	writeHermesVersionBinary,
	writeOpenClawConfigMutationFixture,
	writeTestRuntimeAppliedState,
} from "../src/test-support/runtime-harness";

installRuntimeTestHooks();

describe("runtime manifest datasource", () => {
	it("reconverges the native Hermes provider projection idempotently", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.18.0");
		const loaded = hostedHermesProviderLoad(home);
		const paths = getRuntimePaths();

		convergeRuntimeManifest(loaded, paths);
		const firstConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		const firstRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));

		convergeRuntimeManifest(loaded, paths);

		expect(readFileSync(join(home, ".hermes", "config.yaml"), "utf-8")).toBe(firstConfig);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(false);
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"))).toBe(firstRevision);
	});

	it("leaves a Hermes connection to native credentials and commits the rest", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.18.0");
		// The public pool API reports a native model_config row for banban's base URL.
		const app = join(home, ".hermes", "hermes-agent");
		mkdirSync(join(app, "agent"), { recursive: true });
		mkdirSync(join(app, "hermes_cli"), { recursive: true });
		writeFileSync(
			join(app, "agent", "credential_pool.py"),
			"def custom_provider_pool_key_candidates(base_url, provider_name=None):\n    return ['custom:ai.shared.example']\n",
		);
		writeFileSync(
			join(app, "hermes_cli", "auth.py"),
			"def read_credential_pool(key):\n    return [{'source': 'model_config'}]\n",
		);
		writeFileSync(
			join(app, "venv", "bin", "python"),
			'#!/usr/bin/env bash\ncase "$*" in *uvicorn*) exit 0 ;; esac\nexec python3 "$@"\n',
		);
		const loaded = hostedHermesProviderLoad(home);
		const providers = loaded.manifest.projection?.providers;
		if (!providers) throw new Error("Missing provider projection fixture");
		providers.banban = {
			kind: "openai-compatible",
			type: "custom_openai_compatible",
			configurationMode: "custom",
			managed_by: "user",
			baseUrl: "https://ai.shared.example/v1",
			apiMode: "openai_chat",
			runtimeEnvName: "CLAWDI_PROVIDER_BANBAN_API_KEY",
			apiKeySecretRef: "secret://provider.banban.apiKey",
			cloudIdentity: { providerUuid: randomUUID(), incarnationId: randomUUID() },
		};
		loaded.manifest.runtimes.hermes.provider_ids = ["hermes", "banban"];
		loaded.secretValues = {
			...loaded.secretValues,
			"secret://provider.banban.apiKey": "sk-banban",
		};
		const paths = getRuntimePaths();

		const result = convergeRuntimeManifest(loaded, paths);

		expect(result.installErrors).toEqual([]);
		expect(result.resourceProjectionErrors).toEqual([]);
		expect(result.providerConflicts).toEqual([
			{ runtime: "hermes", providerId: "banban", code: "native_credential_pool_conflict" },
		]);
		const configured = expectRecord(readHermesConfigYaml(home).providers, "Hermes providers");
		expect(configured.hermes).toBeDefined();
		expect(configured.banban).toBeUndefined();
		const journal = JSON.parse(
			readFileSync(join(paths.serviceStateRoot, "provider-ownership.json"), "utf8"),
		);
		expect(journal.transfers.hermes).toEqual({});
	});

	it("ignores a retired Hermes plugin while removing the native provider", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.18.0");
		mkdirSync(hermesModelProviderPluginDir(home), { recursive: true });
		writeFileSync(join(hermesModelProviderPluginDir(home), "__init__.py"), "# stale\n");
		const withProvider = hostedHermesProviderLoad(home);
		const withoutProvider: RuntimeManifestLoad = {
			...withProvider,
			manifest: {
				...withProvider.manifest,
				runtimes: {
					hermes: {
						...withProvider.manifest.runtimes.hermes,
						providerMode: "unmanaged",
						provider_ids: [],
						primary_model: undefined,
					},
				},
				projection: {
					system: { home },
				},
			},
		};
		const paths = getRuntimePaths();

		const first = convergeRuntimeManifest(withProvider, paths);
		writeTestRuntimeAppliedState(paths, withProvider, first);
		const firstRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(true);
		expect(
			expectRecord(readHermesConfigYaml(home).providers, "Hermes providers").hermes,
		).toBeDefined();

		convergeRuntimeManifest(withoutProvider, paths);

		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(true);
		const unmanagedConfig = readHermesConfigYaml(home);
		expect(unmanagedConfig.providers).toBeUndefined();
		expect(unmanagedConfig.model).toBeUndefined();
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"))).not.toBe(firstRevision);
	});

	it("replaces the frozen Hermes model catalog on each manifest generation", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.18.0");
		const withCapabilities = hostedSingleProviderModeLoad(home, "hermes", "configured", 1);
		const managedProvider = expectRecord(
			expectRecord(withCapabilities.manifest.projection?.providers, "managed providers")[
				"clawdi-managed"
			],
			"managed Hermes provider",
		);
		managedProvider.models = [
			{
				id: "gpt-5.5",
				context_window: 262144,
				max_tokens: 32768,
				input_modalities: ["text", "image"],
				supports_vision: true,
				supports_tools: true,
				supports_reasoning: true,
			},
			{ id: "stale-generation-model" },
		];
		const withoutCapabilities: RuntimeManifestLoad = {
			...withCapabilities,
			manifest: {
				...withCapabilities.manifest,
				projection: {
					...withCapabilities.manifest.projection,
					providers: {
						...withCapabilities.manifest.projection?.providers,
						"clawdi-managed": {
							...withCapabilities.manifest.projection?.providers?.["clawdi-managed"],
							models: [{ id: "gpt-5.5" }],
						},
					},
				},
			},
		};

		convergeRuntimeManifest(withCapabilities, getRuntimePaths());
		const initialConfig = readHermesConfigYaml(home);
		const initialModelConfig = expectRecord(initialConfig.model, "initial Hermes model config");
		expect(initialModelConfig.context_length).toBeUndefined();
		expect(initialModelConfig.supports_vision).toBeUndefined();
		const initialProviderModels = expectRecord(
			expectRecord(
				expectRecord(initialConfig.providers, "initial Hermes providers")["clawdi-managed"],
				"initial Hermes provider",
			).models,
			"initial Hermes provider models",
		);
		expect(
			expectRecord(
				expectRecord(initialConfig.providers, "initial Hermes providers")["clawdi-managed"],
				"initial Hermes provider",
			).discover_models,
		).toBe(false);
		expect(initialProviderModels["stale-generation-model"]).toEqual({});
		expect(
			expectRecord(initialProviderModels["gpt-5.5"], "initial Hermes provider model")
				.supports_vision,
		).toBe(true);

		const convergence = convergeRuntimeManifest(withoutCapabilities, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		const hermesConfig = readHermesConfigYaml(home);
		const hermesModel = expectRecord(hermesConfig.model, "Hermes model config");
		expect(hermesModel.context_length).toBeUndefined();
		expect(hermesModel.max_tokens).toBeUndefined();
		expect(hermesModel.supports_vision).toBeUndefined();
		const hermesProvider = expectRecord(
			expectRecord(hermesConfig.providers, "Hermes providers config")["clawdi-managed"],
			"Hermes provider config",
		);
		expect(hermesProvider.api).toBe("https://managed.provider.example.test/v1");
		expect(hermesProvider.discover_models).toBe(false);
		expect(hermesProvider.models).toEqual({ "gpt-5.5": {} });
	});

	it.each(["openclaw", "hermes"] as const)(
		"hot-applies managed %s model, primary model and endpoint changes without a restart",
		(runtimeName) => {
			const caseRoot = join(root, runtimeName);
			const home = join(caseRoot, "home", "clawdi");
			const state = join(caseRoot, "var", "lib", "clawdi");
			const run = join(caseRoot, "run", "clawdi");
			const systemctlLog = join(caseRoot, "systemctl.log");
			const systemctlStateRoot = join(caseRoot, "systemctl-state");
			let openclawConfig: string | null = null;
			mkdirSync(home, { recursive: true });
			if (runtimeName === "openclaw") {
				openclawConfig = writeOpenClawConfigMutationFixture(home).configPath;
			} else {
				writeHermesVersionBinary(home, "0.19.1");
			}
			writeFakeSystemdManager({
				path: join(caseRoot, "bin", "systemctl"),
				logPath: systemctlLog,
				stateRoot: systemctlStateRoot,
			});
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
			process.env.CLAWDI_SYSTEMCTL_PATH = join(caseRoot, "bin", "systemctl");
			process.env.CLAWDI_SYSTEMD_APPLY = "1";
			process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;

			const previous = hostedSingleProviderModeLoad(home, runtimeName, "configured", 1);
			const next = hostedSingleProviderModeLoad(home, runtimeName, "configured", 1);
			const previousProvider = expectRecord(
				previous.manifest.projection?.providers?.["clawdi-managed"],
				"previous managed provider",
			);
			const nextProvider = expectRecord(
				next.manifest.projection?.providers?.["clawdi-managed"],
				"next managed provider",
			);
			previousProvider.models = [
				{ id: "gpt-5.5", label: "GPT-5.5 old", context_window: 128_000 },
				{ id: "stale-model", label: "Stale model" },
			];
			nextProvider.models = [
				{
					id: "gpt-5.5",
					label: "GPT-5.5 refreshed",
					context_window: 512_000,
					max_tokens: 64_000,
					supports_vision: true,
				},
				{ id: "new-model", label: "New model" },
			];

			const paths = getRuntimePaths();
			const first = convergeRuntimeManifest(previous, paths);
			expect(first.installErrors).toEqual([]);
			writeTestRuntimeAppliedState(paths, previous, first);
			const before = readSystemdUnitSnapshot(paths);
			seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, before);
			for (const unit of before.user.keys()) {
				writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
			}
			const runtimeUnit = runtimeName === "openclaw" ? "openclaw-gateway" : "hermes-gateway";
			const initialRevision = systemdEnvDigest(readSystemdEnvFile(paths, runtimeUnit));
			writeFileSync(systemctlLog, "");

			const second = convergeRuntimeManifest(next, paths);
			expect(second.installErrors).toEqual([]);
			const activation = applySystemdRuntimeUpdate(
				paths,
				before,
				readSystemdUnitSnapshot(paths),
				{},
			);

			expect(activation).toMatchObject({
				applied: true,
				systemUnitsChanged: [],
				userUnitsChanged: [],
			});
			expect(systemdEnvDigest(readSystemdEnvFile(paths, runtimeUnit))).toBe(initialRevision);
			const systemctlCalls = readFileSync(systemctlLog, "utf-8");
			const managerReads = systemctlCalls.trim().split("\n");
			expect(managerReads.find((call) => call.startsWith("--user show "))).toContain(
				`${runtimeUnit}.service`,
			);
			expect(managerReads.filter((call) => /^(?:--user )?show /.test(call))).toHaveLength(2);
			expect(managerReads.filter((call) => /^(?:--user )?is-enabled /.test(call))).toHaveLength(2);
			expect(systemctlCalls).not.toMatch(
				/(?:^|\s)(?:start|restart|stop|enable|disable|reset-failed)(?:\s|$)/m,
			);

			if (runtimeName === "openclaw") {
				if (!openclawConfig) throw new Error("OpenClaw config fixture is missing");
				const config = expectRecord(
					JSON.parse(readFileSync(openclawConfig, "utf-8")),
					"OpenClaw config",
				);
				const models = expectRecord(config.models, "OpenClaw models");
				const providers = expectRecord(models.providers, "OpenClaw providers");
				const provider = expectRecord(providers["clawdi-managed"], "OpenClaw managed provider");
				expect(provider.models).toEqual([
					expect.objectContaining({
						id: "gpt-5.5",
						name: "GPT-5.5 refreshed",
						contextWindow: 512_000,
						maxTokens: 64_000,
						input: ["text", "image"],
					}),
					expect.objectContaining({ id: "new-model", name: "New model" }),
				]);
				expect(JSON.stringify(provider)).not.toContain("stale-model");
			} else {
				const provider = expectRecord(
					expectRecord(readHermesConfigYaml(home).providers, "Hermes providers")["clawdi-managed"],
					"Hermes managed provider",
				);
				expect(provider.models).toEqual({
					"gpt-5.5": {
						context_length: 512_000,
						max_tokens: 64_000,
						supports_vision: true,
					},
					"new-model": {},
				});
			}

			const expectHotApply = (change: () => void) => {
				const before = readSystemdUnitSnapshot(paths);
				change();
				writeFileSync(systemctlLog, "");
				const converged = convergeRuntimeManifest(next, paths);
				expect(converged.installErrors).toEqual([]);
				expect(
					applySystemdRuntimeUpdate(paths, before, readSystemdUnitSnapshot(paths), {})
						.userUnitsChanged,
				).toEqual([]);
				expect(systemdEnvDigest(readSystemdEnvFile(paths, runtimeUnit))).toBe(initialRevision);
				expect(readFileSync(systemctlLog, "utf-8")).not.toMatch(
					/(?:^|\s)(?:start|restart|stop)(?:\s|$)/m,
				);
			};
			const runtime = expectRecord(next.manifest.runtimes[runtimeName], "runtime");
			expectHotApply(() => {
				runtime.primary_model = { provider_id: "clawdi-managed", model: "new-model" };
			});
			expectHotApply(() => {
				nextProvider.baseUrl = "https://replacement.provider.example.test/v1";
			});
			if (runtimeName === "openclaw") {
				if (!openclawConfig) throw new Error("OpenClaw config fixture is missing");
				const config = expectRecord(
					JSON.parse(readFileSync(openclawConfig, "utf-8")),
					"OpenClaw config",
				);
				const defaults = expectRecord(
					expectRecord(config.agents, "OpenClaw agents").defaults,
					"OpenClaw agent defaults",
				);
				expect(expectRecord(defaults.model, "OpenClaw default model").primary).toBe(
					"clawdi-managed/new-model",
				);
			} else {
				const hermesConfig = readHermesConfigYaml(home);
				expect(expectRecord(hermesConfig.model, "Hermes model").default).toBe("new-model");
				expect(
					expectRecord(
						expectRecord(hermesConfig.providers, "Hermes providers")["clawdi-managed"],
						"Hermes managed provider",
					).api,
				).toBe("https://replacement.provider.example.test/v1");
			}
		},
	);

	it("uses the same native Hermes projection before and after 0.18.0", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		mkdirSync(home, { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeHermesVersionBinary(home, "0.17.0");
		mkdirSync(hermesModelProviderPluginDir(home), { recursive: true });
		writeFileSync(join(hermesModelProviderPluginDir(home), "__init__.py"), "# stale\n");
		const loaded = hostedHermesProviderLoad(home);
		const paths = getRuntimePaths();

		convergeRuntimeManifest(loaded, paths);

		const yamlRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));
		const initialConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(initialConfig).toContain("provider: custom:hermes");
		expect(initialConfig).toMatch(/api: "?https:\/\/hermes-provider\.example\.test\/v1"?/);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(true);

		writeHermesVersionBinary(home, "0.18.0");
		convergeRuntimeManifest(loaded, paths);

		const currentRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));
		const currentConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(currentConfig).toBe(initialConfig);
		expect(existsSync(hermesModelProviderPluginDir(home))).toBe(true);
		expect(currentRevision).toBe(yamlRevision);
	});

	it("preserves non-OpenAI hosted provider protocols in direct agent projection", () => {
		for (const providerCase of [
			{
				id: "anthropic",
				type: "anthropic",
				baseUrl: "https://api.anthropic.com",
				model: "claude-opus-4-6",
				apiMode: "anthropic_messages",
				expectedOpenClawApi: "anthropic-messages",
			},
			{
				id: "gemini",
				type: "gemini",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				model: "gemini-2.5-pro",
				apiMode: "google_generate_content",
				expectedOpenClawApi: "google-generative-ai",
			},
		]) {
			const caseRoot = join(root, `provider-${providerCase.id}`);
			const home = join(caseRoot, "home", "clawdi");
			const state = join(caseRoot, "var", "lib", "clawdi");
			const run = join(caseRoot, "run", "clawdi");
			const openclawBin = join(home, ".local", "bin", "openclaw");
			const { configPath } = writeOpenClawConfigMutationFixture(home);
			mkdirSync(dirname(openclawBin), { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
			writeFileSync(openclawBin, "#!/bin/sh\nexit 0\n");
			chmodSync(openclawBin, 0o700);

			const loaded = hostedSingleProviderModeLoad(home, "openclaw", "configured", 1);
			const providers = {
				openclaw: {
					kind: "openai-compatible" as const,
					type: providerCase.type,
					baseUrl: providerCase.baseUrl,
					model: providerCase.model,
					apiMode: providerCase.apiMode,
					runtimeEnvName: `${providerCase.id.toUpperCase()}_API_KEY`,
					apiKeySecretRef: "secret://provider.openclaw.apiKey",
				},
			};
			loaded.manifest.runtimes.openclaw.provider_ids = ["openclaw"];
			loaded.manifest.runtimes.openclaw.primary_model = {
				provider_id: "openclaw",
				model: providerCase.model,
			};
			loaded.manifest.projection = { ...loaded.manifest.projection, providers };
			loaded.manifest.egressProfiles = hostedManifestEgressProfiles({ providers });
			loaded.secretValues = {
				"secret://provider.openclaw.apiKey": `sk-${providerCase.id}`,
			};

			const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());
			expect(convergence.installErrors).toEqual([]);
			const patch = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(patch.models.providers.openclaw.api).toBe(providerCase.expectedOpenClawApi);
			expect(patch.models.providers.openclaw.api).not.toBeUndefined();
		}
	});
});
