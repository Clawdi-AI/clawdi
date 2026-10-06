import { describe, expect, it } from "bun:test";

import { createHash } from "node:crypto";

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";

import { dirname, join } from "node:path";

import {
	nativeOAuthProfileId,
	oauthCredentialFingerprint,
} from "../src/lib/codex-oauth-native-store";

import { hostedManifestEgressProfiles } from "../src/runtime/hosted-egress-profiles";

import { createOpenClawHostedContext } from "../src/runtime/hosted-openclaw-context";

import { officialInstallArgs } from "../src/runtime/manifest-contract";

import type { RuntimeManifestLoad } from "../src/runtime/manifest-source";

import { getRuntimePaths } from "../src/runtime/paths";

import {
	convergeAndCommitTestRuntimeManifest,
	convergeRuntimeManifest,
	expectRecord,
	hostedManagedOpenClawV2Load,
	hostedOAuthRuntimeLoad,
	hostedSingleProviderModeLoad,
	hostedSystemFixture,
	installRuntimeTestHooks,
	readHermesConfigYaml,
	readSystemdEnvFile,
	root,
	seedHostedCodexPackage,
	seedMitmproxyCache,
	seedOpenClawBinary,
	TEST_EGRESS_ENGINE_PIN,
	writeFakeOpenClawProviderAuthSdk,
	writeHermesVersionBinary,
	writeHostedCodexNpmInstaller,
	writeOpenClawConfigMutationFixture,
	writeTestRuntimeAppliedState,
} from "../src/test-support/runtime-harness";

installRuntimeTestHooks();

describe("runtime manifest datasource", () => {
	it("projects hosted OpenAI chat providers directly into OpenClaw config", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-provider-patch.json");
		const openclawCommand = join(root, "openclaw-provider-command.txt");
		const { configPath } = writeOpenClawConfigMutationFixture(home);
		mkdirSync(dirname(openclawBin), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			openclawBin,
			[
				"#!/bin/sh",
				`printf '%s\\n' "$*" >> '${openclawCommand}'`,
				'if [ "$1 $2 $3" = "config patch --stdin" ]; then',
				`  cat > '${openclawPatch}'`,
				"  exit 0",
				"fi",
				"printf 'unexpected openclaw command: %s\\n' \"$*\" >&2",
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(openclawBin, 0o700);

		const loaded: RuntimeManifestLoad = {
			source: "remote-datasource",
			sourcePath: "https://runtime-source.test/desired-state",
			offline: false,
			secretValues: {
				"secret://provider.default.apiKey": "sk-runtime-provider",
				"secret://runtime/openclaw/gateway-token": "gateway-token",
			},
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_direct_provider",
				environmentId: "env_direct_provider",
				instanceId: "iid_direct_provider",
				generation: 1,
				issuedAt: "2026-06-22T00:00:00Z",
				locale: { language: "fr", timezone: "Europe/Paris" },
				workspaceRoot: join(home, "clawdi"),
				controlPlane: { apiUrl: "https://cloud-api.test" },
				openclawGatewayAuth: {
					mode: "token",
					tokenRef: "secret://runtime/openclaw/gateway-token",
					deviceAuthRequired: false,
					activation: { enabled: true, capability: "openclaw-native-auth-v1" },
				},
				runtimes: {
					openclaw: {
						enabled: true,
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-5.4-mini" },
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: officialInstallArgs("openclaw", home),
						},
					},
					hermes: { enabled: false },
				},
				projection: {
					system: {
						...hostedSystemFixture(home),
						home,
						openclawControlUiAllowedOrigins: ["https://app-v2-18789.k3s.example.test"],
					},
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://ai-gateway.example.test/v1",
							model: "gpt-5.4-mini",
							apiMode: "openai_chat",
							runtimeEnvName: "OPENAI_API_KEY",
							apiKeySecretRef: "secret://provider.default.apiKey",
						},
					},
				},
				egressProfiles: { profiles: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf-8").trim()).toBe("config patch --stdin");
		expect(JSON.parse(readFileSync(openclawPatch, "utf-8"))).toEqual({
			agents: {
				defaults: {
					userTimezone: "Europe/Paris",
				},
			},
			gateway: {
				mode: "local",
				port: 18789,
				bind: "lan",
				auth: {
					mode: "token",
					token: "gateway-token",
				},
				controlUi: {
					allowedOrigins: ["https://app-v2-18789.k3s.example.test"],
					basePath: "/",
					dangerouslyAllowHostHeaderOriginFallback: false,
					dangerouslyDisableDeviceAuth: true,
				},
			},
		});
		const patch = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(patch.agents.defaults.model.primary).toBe("default/gpt-5.4-mini");
		expect(patch.secrets).toEqual({
			providers: {
				default: { source: "env" },
			},
			defaults: {
				env: "default",
			},
		});
		expect(patch.models.providers.default).toMatchObject({
			baseUrl: "https://ai-gateway.example.test/v1",
			apiKey: {
				source: "env",
				provider: "default",
				id: "OPENAI_API_KEY",
			},
		});
		expect(patch.models.providers.default.apiKey.id).not.toBe("CLAWDI_AI_API_KEY");
		expect(patch.models.providers.default.api).toBeUndefined();
		expect(JSON.stringify(patch)).not.toContain("agentRuntime");
		expect(JSON.stringify(patch)).not.toContain("chatgpt.com");
		const runConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
		);
		expect(runConfig.defaultArgs).toEqual(["gateway", "run"]);
		expect(runConfig.defaultArgs).not.toContain("--auth");
		expect(runConfig.env.CLAWDI_AI_API_KEY).toBeUndefined();
		expect(runConfig.env.OPENAI_API_KEY).toBeUndefined();
		expect(runConfig.secretEnv).toEqual({ OPENAI_API_KEY: "secret://provider.default.apiKey" });
		expect(runConfig.secretFilePath).toBeNull();
		expect(JSON.stringify(runConfig)).not.toContain("sk-runtime-provider");
	});

	it("pins OpenClaw context and repairs config before provider projection", () => {
		const home = join(root, "invalid-openclaw-config", "home", "clawdi");
		const state = join(root, "invalid-openclaw-config", "var", "lib", "clawdi");
		const run = join(root, "invalid-openclaw-config", "run", "clawdi");
		const openClawTmp = join(home, ".openclaw", "tmp");
		const { configPath, commandLog } = writeOpenClawConfigMutationFixture(home, {
			legacyInvalidConfig: true,
			meta: "legacy",
			agents: [],
		});
		mkdirSync(openClawTmp, { recursive: true });
		chmodSync(openClawTmp, 0o500);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.OPENCLAW_STATE_DIR = "/tmp/untrusted-openclaw-state";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "invalid-openclaw-config", "provider-auth"),
			join(root, "invalid-openclaw-config", "provider-auth-calls.log"),
		);
		const paths = getRuntimePaths();
		const loaded = hostedManagedOpenClawV2Load(home, 1);
		loaded.manifest.egressEngine = seedMitmproxyCache(paths);

		const convergence = convergeRuntimeManifest(loaded, paths);

		expect(convergence.installErrors).toEqual([]);
		const commands = readFileSync(commandLog, "utf8").trim().split("\n");
		const doctorIndex = commands.indexOf("doctor --fix --non-interactive");
		expect(doctorIndex, commands.join(" | ")).toBeGreaterThan(-1);
		expect(commands.some((command) => command.startsWith("plugins "))).toBe(false);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).not.toHaveProperty("legacyInvalidConfig");
		expect(statSync(openClawTmp).mode & 0o777).toBe(0o700);

		const context = createOpenClawHostedContext(loaded.manifest, home);
		loaded.manifest.runtimes.openclaw.enabled = false;
		expect(context.managedApiKeyProjection).toBe(true);
		expect(createOpenClawHostedContext(loaded.manifest, home).managedApiKeyProjection).toBe(false);
	});

	it("removes reserved OpenClaw provider auth from every store only for managed env projection", () => {
		const home = join(root, "model-switch", "home", "clawdi");
		const state = join(root, "model-switch", "var", "lib", "clawdi");
		const run = join(root, "model-switch", "run", "clawdi");
		const activeAgentDir = join(home, "active-openclaw-agent");
		const customAgentDir = join(home, "custom-openclaw-agent");
		const legacyModels = Array.from({ length: 24 }, (_, index) => ({
			id: `legacy-${index}`,
			name: `Legacy managed model ${index}`,
			api: "openai-responses",
			input: ["text", "image"],
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
		}));
		const {
			configPath: openclawConfig,
			commandLog,
			mutationLog,
		} = writeOpenClawConfigMutationFixture(home, {
			gateway: { mode: "local", port: 19_001 },
			logging: { level: "debug" },
			agents: { list: [{ id: "custom", agentDir: customAgentDir }] },
			auth: {
				profiles: {
					"clawdi:default": { provider: "clawdi", mode: "api_key" },
					"managed-config": { provider: "ClAwDi", mode: "token" },
					"clawdi:named-openai": { provider: "openai", mode: "oauth" },
					"openai:user": { provider: "openai", mode: "oauth" },
				},
				order: {
					ClAwDi: ["managed-config", "clawdi:default"],
					openai: ["openai:user", "managed-config", "clawdi:named-openai"],
					"stale-only": ["clawdi:default"],
				},
			},
			models: {
				providers: {
					"user-owned": {
						baseUrl: "https://user.provider.example.test/v1",
						api: "openai-completions",
						models: [{ id: "user-model", name: "User model" }],
					},
					clawdi: {
						baseUrl: "https://managed.provider.example.test/v1",
						api: "openai-responses",
						apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
						models: legacyModels,
					},
				},
			},
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.OPENCLAW_AGENT_DIR = activeAgentDir;
		const providerAuthCalls = join(root, "model-switch", "provider-auth-calls.log");
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "model-switch", "provider-auth"),
			providerAuthCalls,
		);

		const activeStore = join(activeAgentDir, "openclaw-agent.sqlite");
		const mainStore = join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
		const secondaryStore = join(
			home,
			".openclaw",
			"agents",
			"research",
			"agent",
			"openclaw-agent.sqlite",
		);
		const customStore = join(customAgentDir, "openclaw-agent.sqlite");
		const stores = new Map<string, Record<string, unknown>>([
			[
				activeStore,
				{
					profiles: {
						"clawdi:default": {
							type: "api_key",
							provider: "clawdi",
							key: "CLAWDI_AI_API_KEY",
						},
						"clawdi:legitimate": {
							type: "api_key",
							provider: "clawdi",
							key: "sk-real-but-reserved-provider",
						},
						"clawdi:named-openai": {
							type: "oauth",
							provider: "openai",
							access: "preserve-by-provider",
						},
						"openai:user": { type: "oauth", provider: "openai", access: "preserve" },
					},
					order: {
						clawdi: ["clawdi:legitimate", "clawdi:default"],
						openai: ["openai:user", "clawdi:named-openai"],
					},
					lastGood: { clawdi: "clawdi:legitimate", openai: "openai:user" },
					usageStats: {
						"clawdi:default": { lastUsed: 1 },
						"clawdi:legitimate": { lastUsed: 2 },
						"clawdi:named-openai": { lastUsed: 10 },
						"openai:user": { lastUsed: 3 },
					},
				},
			],
			[
				mainStore,
				{
					profiles: {
						"arbitrary-id": { type: "token", provider: "ClAwDi", token: "remove" },
						"anthropic:user": { type: "api_key", provider: "anthropic", key: "preserve" },
					},
					order: { clawdi: ["arbitrary-id"], anthropic: ["anthropic:user"] },
					lastGood: { clawdi: "arbitrary-id", anthropic: "anthropic:user" },
					usageStats: { "arbitrary-id": { lastUsed: 4 }, "anthropic:user": { lastUsed: 5 } },
				},
			],
			[
				secondaryStore,
				{
					profiles: {
						"models-json": { type: "api_key", provider: "clawdi", key: "remove" },
						"user:secondary": { type: "api_key", provider: "user-provider", key: "preserve" },
					},
					order: { clawdi: ["models-json"], "user-provider": ["user:secondary"] },
					lastGood: { clawdi: "models-json", "user-provider": "user:secondary" },
					usageStats: { "models-json": { lastUsed: 6 }, "user:secondary": { lastUsed: 7 } },
				},
			],
			[
				customStore,
				{
					profiles: {
						"custom-agent-clawdi": { type: "oauth", provider: "clawdi", access: "remove" },
						"custom-agent-openai": { type: "oauth", provider: "openai", access: "preserve" },
					},
					order: { clawdi: ["custom-agent-clawdi"], openai: ["custom-agent-openai"] },
					lastGood: { clawdi: "custom-agent-clawdi", openai: "custom-agent-openai" },
					usageStats: {
						"custom-agent-clawdi": { lastUsed: 8 },
						"custom-agent-openai": { lastUsed: 9 },
					},
				},
			],
		]);
		for (const [path, store] of stores) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
		}

		const paths = getRuntimePaths();
		const loaded = hostedManagedOpenClawV2Load(home, 2);
		loaded.manifest.egressEngine = seedMitmproxyCache(paths);

		let failedAuthorityCommit = false;
		writeFileSync(`${providerAuthCalls}.fail`, "1\n");
		const failedCleanup = convergeRuntimeManifest(loaded, paths, {
			commitAuthority: () => {
				failedAuthorityCommit = true;
			},
		});
		rmSync(`${providerAuthCalls}.fail`);
		expect(failedCleanup.installErrors.join("\n")).toContain(
			"simulated provider-auth cleanup failure",
		);
		expect(failedAuthorityCommit).toBe(false);
		const convergence = convergeRuntimeManifest(loaded, paths);

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(commandLog, "utf-8")).not.toContain("config patch --stdin --replace-path");
		const mutations = JSON.parse(readFileSync(mutationLog, "utf8"));
		expect(mutations).toHaveLength(2);
		const mutation = mutations[0];
		expect(mutation).toMatchObject({
			base: "source",
			afterWrite: { mode: "none" },
			allowConfigSizeDrop: true,
		});
		expect(mutation.nextBytes).toBeLessThan(Math.floor(mutation.beforeBytes * 0.5));
		expect(mutation.explicitSetPaths).toContainEqual(["models", "providers", "clawdi"]);
		expect(mutations[1]).toMatchObject({
			base: "source",
			afterWrite: { mode: "none" },
			allowConfigSizeDrop: true,
			mutationResult: true,
		});
		const appliedConfig = JSON.parse(readFileSync(openclawConfig, "utf-8"));
		expect(appliedConfig.agents.defaults.model.primary).toBe("clawdi/sol");
		expect(appliedConfig.models.mode).toBe("replace");
		expect(appliedConfig.models.providers.clawdi.models).toEqual([
			expect.objectContaining({ id: "sol" }),
		]);
		expect(appliedConfig.models.providers.clawdi.api).toBe("openai-responses");
		expect(appliedConfig.models.providers.clawdi.auth).toBe("api-key");
		expect(appliedConfig.models.providers.clawdi.apiKey).toEqual({
			source: "env",
			provider: "default",
			id: "CLAWDI_AI_API_KEY",
		});
		expect(appliedConfig.models.providers["user-owned"].models).toEqual([
			{ id: "user-model", name: "User model" },
		]);
		expect(appliedConfig.gateway).toEqual({ mode: "local", port: 19_001 });
		expect(appliedConfig.logging).toEqual({ level: "debug" });
		expect(appliedConfig.auth).toEqual({
			profiles: {
				"clawdi:named-openai": { provider: "openai", mode: "oauth" },
				"openai:user": { provider: "openai", mode: "oauth" },
			},
			order: { openai: ["openai:user", "clawdi:named-openai"] },
		});
		expect(JSON.stringify(appliedConfig)).not.toContain("legacy-");
		for (const path of stores.keys()) {
			const store = JSON.parse(readFileSync(path, "utf8"));
			expect(
				Object.values(store.profiles).some(
					(credential) =>
						(credential as { provider?: string }).provider?.toLowerCase() === "clawdi",
				),
			).toBe(false);
			expect(store.order?.clawdi).toBeUndefined();
			expect(store.lastGood?.clawdi).toBeUndefined();
		}
		expect(JSON.parse(readFileSync(activeStore, "utf8"))).toMatchObject({
			profiles: {
				"clawdi:named-openai": { access: "preserve-by-provider" },
				"openai:user": { access: "preserve" },
			},
			order: { openai: ["openai:user", "clawdi:named-openai"] },
			lastGood: { openai: "openai:user" },
			usageStats: {
				"clawdi:named-openai": { lastUsed: 10 },
				"openai:user": { lastUsed: 3 },
			},
		});
		expect(JSON.parse(readFileSync(mainStore, "utf8")).profiles["anthropic:user"]).toEqual({
			type: "api_key",
			provider: "anthropic",
			key: "preserve",
		});
		expect(JSON.parse(readFileSync(secondaryStore, "utf8")).profiles["user:secondary"]).toEqual({
			type: "api_key",
			provider: "user-provider",
			key: "preserve",
		});
		expect(JSON.parse(readFileSync(customStore, "utf8")).profiles["custom-agent-openai"]).toEqual({
			type: "oauth",
			provider: "openai",
			access: "preserve",
		});

		const afterCleanup = new Map(
			[...stores.keys()].map((path) => [path, readFileSync(path, "utf8")]),
		);
		const configAfterCleanup = readFileSync(openclawConfig, "utf8");
		const idempotent = convergeRuntimeManifest(loaded, paths);
		expect(idempotent.installErrors).toEqual([]);
		for (const [path, content] of afterCleanup) expect(readFileSync(path, "utf8")).toBe(content);
		expect(readFileSync(openclawConfig, "utf8")).toBe(configAfterCleanup);
		expect(JSON.parse(readFileSync(mutationLog, "utf8"))).toEqual(mutations);

		writeTestRuntimeAppliedState(paths, loaded, convergence);
		const unmanagedCredential = JSON.parse(readFileSync(secondaryStore, "utf8"));
		unmanagedCredential.profiles["clawdi:unmanaged"] = {
			type: "api_key",
			provider: "clawdi",
			key: "preserve-without-managed-projection",
		};
		writeFileSync(secondaryStore, `${JSON.stringify(unmanagedCredential, null, 2)}\n`);
		const configBeforeUnmanaged = JSON.parse(readFileSync(openclawConfig, "utf8"));
		configBeforeUnmanaged.auth.profiles["clawdi:unmanaged"] = {
			provider: "clawdi",
			mode: "api_key",
		};
		configBeforeUnmanaged.auth.order.clawdi = ["clawdi:unmanaged"];
		writeFileSync(openclawConfig, `${JSON.stringify(configBeforeUnmanaged, null, 2)}\n`);
		const unmanagedLoad = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 3);
		unmanagedLoad.manifest.egressEngine = TEST_EGRESS_ENGINE_PIN;
		const unmanaged = convergeRuntimeManifest(unmanagedLoad, paths);
		expect(unmanaged.installErrors).toEqual([]);
		const deletionMutations = JSON.parse(readFileSync(mutationLog, "utf8"));
		const deletionMutation = deletionMutations.at(-1);
		expect(deletionMutation.unsetPaths).toContainEqual(["models", "providers", "clawdi"]);
		const unmanagedConfig = JSON.parse(readFileSync(openclawConfig, "utf8"));
		expect(unmanagedConfig.models.mode).toBe("merge");
		expect(unmanagedConfig.models.providers.clawdi).toBeUndefined();
		expect(unmanagedConfig.models.providers["user-owned"]).toEqual(
			appliedConfig.models.providers["user-owned"],
		);
		expect(unmanagedConfig.auth.profiles["clawdi:unmanaged"]).toEqual({
			provider: "clawdi",
			mode: "api_key",
		});
		expect(unmanagedConfig.auth.order.clawdi).toEqual(["clawdi:unmanaged"]);
		expect(
			JSON.parse(readFileSync(secondaryStore, "utf8")).profiles["clawdi:unmanaged"],
		).toMatchObject({ key: "preserve-without-managed-projection" });
	});

	it.each(["0.100.0", "0.147.0"])("preserves healthy installed Hosted Codex %s", (version) => {
		const home = join(root, "codex-user-upgraded", "home", "clawdi");
		const state = join(root, "codex-user-upgraded", "var", "lib", "clawdi");
		const run = join(root, "codex-user-upgraded", "run", "clawdi");
		const binDir = join(root, "codex-user-upgraded", "fake-bin");
		const installMarker = join(root, "codex-user-upgraded", "npm-install.txt");
		const previousPath = process.env.PATH;
		seedOpenClawBinary(home);
		const { packageJson } = seedHostedCodexPackage(home, version);
		writeHostedCodexNpmInstaller(binDir, installMarker, "0.146.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");
		delete process.env.CLAWDI_CODEX_INSTALL_DISABLED;

		try {
			const convergence = convergeRuntimeManifest(
				hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 1),
				getRuntimePaths(),
			);
			expect(convergence.installErrors).toEqual([]);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		}

		expect(existsSync(installMarker)).toBe(false);
		expect(JSON.parse(readFileSync(packageJson, "utf8")).version).toBe(version);
		expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(
			'model_provider = "clawdi"',
		);
		expect(existsSync(join(getRuntimePaths().userNpmPrefix, "bin", "codex"))).toBe(true);
	});

	it("bootstraps missing or damaged Hosted Codex packages", () => {
		const previousPath = process.env.PATH;
		const cases = [
			{ name: "missing" },
			{ name: "damaged", version: "0.146.0", validPackageJson: false },
			{ name: "non-executable", version: "0.146.0", executable: false },
		] as const;

		try {
			for (const packageCase of cases) {
				const caseRoot = join(root, `codex-${packageCase.name}`);
				const home = join(caseRoot, "home", "clawdi");
				const state = join(caseRoot, "var", "lib", "clawdi");
				const run = join(caseRoot, "run", "clawdi");
				const binDir = join(caseRoot, "fake-bin");
				const installMarker = join(caseRoot, "npm-install.txt");
				seedOpenClawBinary(home);
				if ("version" in packageCase) {
					seedHostedCodexPackage(home, packageCase.version, {
						executable: "executable" in packageCase ? packageCase.executable : undefined,
						validPackageJson:
							"validPackageJson" in packageCase ? packageCase.validPackageJson : undefined,
					});
				}
				writeHostedCodexNpmInstaller(binDir, installMarker, "0.150.0");
				process.env.HOME = home;
				process.env.CLAWDI_RUNTIME_MODE = "hosted";
				process.env.CLAWDI_SERVICE_STATE_DIR = state;
				process.env.CLAWDI_RUN_DIR = run;
				process.env.CLAWDI_SYSTEMD_APPLY = "0";
				process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");
				delete process.env.CLAWDI_CODEX_INSTALL_DISABLED;

				const convergence = convergeRuntimeManifest(
					hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 1),
					getRuntimePaths(),
				);
				expect(convergence.installErrors).toEqual([]);
				expect(readFileSync(installMarker, "utf8")).toBe("install\n");
				expect(
					JSON.parse(
						readFileSync(
							join(getRuntimePaths().userNpmPrefix, "lib/node_modules/@openai/codex/package.json"),
							"utf8",
						),
					).version,
				).toBe("0.150.0");
			}
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		}
	});

	it.each([
		["invalid", "@openai/codex"],
		["0.154.0", "other-package"],
	])("fails closed for Codex metadata %s / %s", (version, name) => {
		const home = join(root, "codex-invalid-version", "home", "clawdi");
		const state = join(root, "codex-invalid-version", "var", "lib", "clawdi");
		const run = join(root, "codex-invalid-version", "run", "clawdi");
		const binDir = join(root, "codex-invalid-version", "fake-bin");
		const installMarker = join(root, "codex-invalid-version", "npm-install.txt");
		const previousPath = process.env.PATH;
		seedOpenClawBinary(home);
		writeHostedCodexNpmInstaller(binDir, installMarker, version, name);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");
		delete process.env.CLAWDI_CODEX_INSTALL_DISABLED;

		try {
			const convergence = convergeRuntimeManifest(
				hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 1),
				getRuntimePaths(),
			);
			expect(convergence.installErrors.join("\n")).toContain(
				"Codex bootstrap did not install valid package metadata",
			);
			expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			process.env.CLAWDI_CODEX_INSTALL_DISABLED = "1";
		}
	});

	it("does not mutate live config when Codex bootstrap fails", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const binDir = join(root, "fake-bin");
		const previousPath = process.env.PATH;
		mkdirSync(binDir, { recursive: true });
		writeFileSync(join(binDir, "npm"), "#!/usr/bin/env bash\necho npm failed >&2\nexit 42\n");
		chmodSync(join(binDir, "npm"), 0o755);
		seedOpenClawBinary(home);
		writeHermesVersionBinary(home, "0.18.0");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.PATH = [binDir, previousPath].filter(Boolean).join(":");
		delete process.env.CLAWDI_CODEX_INSTALL_DISABLED;
		const paths = getRuntimePaths();
		const liveFiles = [
			join(paths.runConfigRoot, "stale-runtime.json"),
			join(paths.systemdUserRoot, "openclaw-gateway.service"),
		];
		for (const path of liveFiles) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `generation-1:${path.split("/").at(-1)}\n`);
		}
		const previousLiveSnapshot = Object.fromEntries(
			liveFiles.map((path) => [path, readFileSync(path, "utf-8")]),
		);

		try {
			const convergence = convergeRuntimeManifest(
				hostedSingleProviderModeLoad(home, "openclaw", "configured", 2),
				paths,
			);

			expect(convergence.installErrors.join("\n")).toContain("runtime codex setup failed");
			expect(convergence.outputs.systemdSystemUnits).toEqual([]);
			expect(convergence.outputs.systemdUserUnits).toEqual([]);
			for (const [path, content] of Object.entries(previousLiveSnapshot)) {
				expect(readFileSync(path, "utf-8")).toBe(content);
			}
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
		}
	});

	it.each(["openclaw", "hermes"] as const)(
		"converges %s in unmanaged mode without touching user provider config",
		(runtimeName) => {
			const home = join(root, runtimeName, "home", "clawdi");
			const state = join(root, runtimeName, "var", "lib", "clawdi");
			const run = join(root, runtimeName, "run", "clawdi");
			const workspace = home;
			mkdirSync(workspace, { recursive: true });
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;

			let userConfigPath: string;
			let userConfig: string;
			if (runtimeName === "openclaw") {
				seedOpenClawBinary(home);
				userConfigPath = join(home, ".openclaw", "openclaw.json");
				userConfig =
					'{"models":{"providers":{"user-local":{"baseUrl":"http://localhost:11434/v1"}}}}\n';
				writeFileSync(userConfigPath, userConfig);
			} else {
				writeHermesVersionBinary(home, "0.18.0");
				userConfigPath = join(home, ".hermes", "config.yaml");
				userConfig = 'providers:\n  user-local:\n    api: "http://localhost:11434/v1"\n';
				mkdirSync(dirname(userConfigPath), { recursive: true });
				writeFileSync(userConfigPath, userConfig);
			}
			const userCodexConfig = join(home, ".codex", "config.toml");
			mkdirSync(dirname(userCodexConfig), { recursive: true });
			writeFileSync(userCodexConfig, "# preserve me byte-for-byte\n");

			const paths = getRuntimePaths();
			const load = hostedSingleProviderModeLoad(home, runtimeName, "unmanaged", 1);
			const convergence = convergeRuntimeManifest(load, paths);
			writeTestRuntimeAppliedState(paths, load, convergence);

			expect(convergence.installErrors).toEqual([]);
			expect(convergence.projectedProviderIds[runtimeName]).toEqual([]);
			expect(convergence.projectedProviderIds.codex).toEqual(["clawdi"]);
			if (runtimeName === "openclaw") {
				expect(
					JSON.parse(readFileSync(userConfigPath, "utf-8")).models.providers["user-local"],
				).toEqual({ baseUrl: "http://localhost:11434/v1" });
			} else {
				expect(
					expectRecord(readHermesConfigYaml(home).providers, "Hermes providers")["user-local"],
				).toEqual({ api: "http://localhost:11434/v1" });
			}
			expect(readFileSync(userCodexConfig, "utf-8")).toContain('model_provider = "clawdi"');
			const runConfig = JSON.parse(
				readFileSync(join(getRuntimePaths().runConfigRoot, `${runtimeName}.json`), "utf-8"),
			);
			expect(runConfig.secretEnv).toEqual(
				runtimeName === "openclaw"
					? { OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token" }
					: {},
			);
			expect(JSON.stringify(runConfig)).not.toContain("OPENAI_API_KEY");
			expect(JSON.stringify(runConfig)).not.toContain("clawdi-egress-placeholder");
			expect(runConfig.secretFilePath).toBeNull();
			const runtimeUnit = runtimeName === "openclaw" ? "openclaw-gateway" : "hermes-gateway";
			const runtimeUnitEnv = readSystemdEnvFile(paths, runtimeUnit);
			for (const forbidden of [
				"OPENAI_API_KEY",
				"CLAWDI_AI_API_KEY",
				"provider.clawdi-managed",
				"egress-secrets.json",
			]) {
				expect(runtimeUnitEnv).not.toContain(forbidden);
			}
			const egressSecrets = readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8");
			expect(egressSecrets).toContain("secret://tool.codex.apiKey");
			expect(egressSecrets).toContain("sk-codex-tool");
			const applied = JSON.parse(readFileSync(paths.appliedState, "utf-8"));
			expect(applied.providerIds).toEqual([]);
			expect(applied.projectedProviderIds[runtimeName]).toEqual([]);
			expect(applied.projectedProviderIds.codex).toEqual(["clawdi"]);
		},
	);

	it("removes only the runtime provider projection on configured to unmanaged", () => {
		const home = join(root, "owned-cleanup", "home", "clawdi");
		const state = join(root, "owned-cleanup", "var", "lib", "clawdi");
		const run = join(root, "owned-cleanup", "run", "clawdi");
		mkdirSync(join(home, "clawdi"), { recursive: true });
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const userCodexConfig = join(home, ".codex", "config.toml");
		mkdirSync(dirname(userCodexConfig), { recursive: true });
		writeFileSync(userCodexConfig, '# user-owned bytes\nmodel = "user-model"\n');
		const paths = getRuntimePaths();
		const configuredLoad = hostedSingleProviderModeLoad(home, "openclaw", "configured", 1);
		const configured = convergeRuntimeManifest(configuredLoad, paths);
		expect(configured.installErrors).toEqual([]);
		writeTestRuntimeAppliedState(paths, configuredLoad, configured);
		const codexConfig = join(home, ".codex", "config.toml");
		expect(readFileSync(codexConfig, "utf-8")).toContain('env_key = "CLAWDI_AI_API_KEY"');
		const expectedCodexConfig = readFileSync(codexConfig, "utf-8");

		const unmanaged = convergeRuntimeManifest(
			hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 2),
			paths,
		);

		expect(unmanaged.installErrors).toEqual([]);
		expect(unmanaged.projectedProviderIds).toMatchObject({
			codex: ["clawdi"],
			openclaw: [],
		});
		expect(readFileSync(codexConfig, "utf-8")).toBe(expectedCodexConfig);
		const runConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
		);
		expect(runConfig.secretEnv).toEqual({
			OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
		});
		expect(JSON.stringify(runConfig)).not.toContain("OPENAI_API_KEY");
		expect(runConfig.secretFilePath).toBeNull();
		expect(readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8")).toContain(
			"sk-codex-tool",
		);
	});

	it("keeps BYOK provider secrets sidecar-only across configured to unmanaged", () => {
		const home = join(root, "byok-cleanup", "home", "clawdi");
		const state = join(root, "byok-cleanup", "var", "lib", "clawdi");
		const run = join(root, "byok-cleanup", "run", "clawdi");
		mkdirSync(join(home, "clawdi"), { recursive: true });
		seedOpenClawBinary(home);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		const paths = getRuntimePaths();
		const configuredLoad = hostedSingleProviderModeLoad(home, "openclaw", "configured", 1);
		const byokProviders = {
			"user-byok": {
				kind: "openai-compatible",
				baseUrl: "https://byok.provider.example.test/v1",
				model: "user-model",
				models: [{ id: "user-model" }],
				apiMode: "openai_responses",
				managed_by: "user",
				runtimeEnvName: "OPENAI_API_KEY",
				apiKeySecretRef: "secret://provider.user-byok.apiKey",
			},
		};
		const terminalTooling = configuredLoad.manifest.projection?.terminalTooling;
		configuredLoad.manifest = {
			...configuredLoad.manifest,
			runtimes: {
				openclaw: {
					...configuredLoad.manifest.runtimes.openclaw,
					provider_ids: ["user-byok"],
					primary_model: { provider_id: "user-byok", model: "user-model" },
				},
			},
			projection: {
				...configuredLoad.manifest.projection,
				providers: byokProviders,
			},
			egressProfiles: hostedManifestEgressProfiles({ providers: byokProviders, terminalTooling }),
		};
		configuredLoad.secretValues = {
			...configuredLoad.secretValues,
			"secret://provider.user-byok.apiKey": "sk-user-byok",
		};
		const configured = convergeRuntimeManifest(configuredLoad, paths);
		expect(configured.installErrors).toEqual([]);
		writeTestRuntimeAppliedState(paths, configuredLoad, configured);
		const configuredRunConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
		);
		expect(configuredRunConfig.secretFilePath).toBeNull();

		const unmanagedLoad = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 2);
		const unmanaged = convergeRuntimeManifest(unmanagedLoad, paths);

		expect(unmanaged.installErrors).toEqual([]);
		expect(
			JSON.parse(readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"))
				.secretFilePath,
		).toBeNull();
		expect(readSystemdEnvFile(paths, "openclaw-gateway")).not.toContain("OPENAI_API_KEY");
		expect(readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8")).toContain(
			"sk-codex-tool",
		);
		expect(existsSync(join(home, ".codex", "config.toml"))).toBe(true);
	});

	it("projects complete OpenClaw gateway config before the official service installer", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawCommand = join(root, "openclaw-command.log");
		const openclawConfig = join(home, ".openclaw", "openclaw.json");
		const installerToken = join(root, "openclaw-installer-token");
		const configPatchFailure = join(root, "fail-openclaw-config-patch");
		const patchCount = join(root, "openclaw-patch-count");
		const unitPath = join(home, ".config", "systemd", "user", "openclaw-gateway.service");
		const gatewayEnvPath = join(run, "systemd", "env", "openclaw-gateway.service.env");
		writeOpenClawConfigMutationFixture(home);
		mkdirSync(dirname(openclawBin), { recursive: true });
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFileSync(
			openclawBin,
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then printf "OpenClaw test-version\\n"; exit 0; fi',
				`printf '%s\\n' "$*" >> '${openclawCommand}'`,
				'if [ "$1 $2 $3" = "config patch --stdin" ]; then',
				`  [ ! -e '${configPatchFailure}' ] || exit 73`,
				`  count=$(cat '${patchCount}' 2>/dev/null || printf '0')`,
				"  count=$((count + 1))",
				`  printf '%s' "$count" > '${patchCount}'`,
				`  cat > '${root}'/openclaw-patch-"$count".json`,
				`  if grep -F '"gateway"' '${root}'/openclaw-patch-"$count".json >/dev/null; then`,
				`    mkdir -p '${dirname(openclawConfig)}'`,
				`    cp '${root}'/openclaw-patch-"$count".json '${openclawConfig}'`,
				"  fi",
				"  exit 0",
				"fi",
				'if [ "$1 $2 $3 $4" = "gateway install --force --json" ]; then',
				`  [ "\${OPENCLAW_GATEWAY_TOKEN:-}" = 'gateway-token' ] || exit 71`,
				`  grep -F '"token": "gateway-token"' '${openclawConfig}' >/dev/null || exit 72`,
				`  printf '%s\\n' "\${OPENCLAW_GATEWAY_TOKEN}" > '${installerToken}'`,
				`  mkdir -p '${dirname(unitPath)}'`,
				`  printf '%s\\n' '[Unit]' '[Service]' 'ExecStart=${openclawBin} gateway run' > '${unitPath}'`,
				"  printf '{\"ok\":true}\\n'",
				"  exit 0",
				"fi",
				"printf 'unexpected openclaw command: %s\\n' \"$*\" >&2",
				"exit 2",
				"",
			].join("\n"),
		);
		chmodSync(openclawBin, 0o700);
		// Prior-generation state: a stale persisted gateway token in the official
		// config location, exactly as a previous boot would have left it.
		mkdirSync(dirname(openclawConfig), { recursive: true });
		writeFileSync(
			openclawConfig,
			`${JSON.stringify({
				gateway: {
					mode: "local",
					auth: { mode: "token", token: "stale-installer-token" },
				},
			})}\n`,
		);

		const loaded: RuntimeManifestLoad = {
			source: "remote-datasource",
			sourcePath: "https://runtime-source.test/desired-state",
			offline: false,
			secretValues: {
				"secret://provider.default.apiKey": "sk-runtime-provider",
				"secret://runtime/openclaw/gateway-token": "gateway-token",
			},
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_openclaw_gateway_repatch",
				environmentId: "env_openclaw_gateway_repatch",
				instanceId: "iid_openclaw_gateway_repatch",
				generation: 1,
				issuedAt: "2026-06-22T00:00:00Z",
				workspaceRoot: join(home, "clawdi"),
				controlPlane: { apiUrl: "https://cloud-api.test" },
				openclawGatewayAuth: {
					mode: "token",
					tokenRef: "secret://runtime/openclaw/gateway-token",
					deviceAuthRequired: false,
					activation: { enabled: true, capability: "openclaw-native-auth-v1" },
				},
				runtimes: {
					openclaw: {
						enabled: true,
						run: {
							command: openclawBin,
							args: ["gateway", "run"],
							env: {},
							secretEnv: {
								OPENCLAW_GATEWAY_TOKEN: "secret://runtime/openclaw/gateway-token",
							},
							prependPath: [],
						},
						provider_ids: ["default"],
						primary_model: { provider_id: "default", model: "gpt-5.4-mini" },
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: ["--json", "--no-onboard"],
						},
					},
				},
				projection: {
					system: {
						...hostedSystemFixture(home),
						home,
						openclawControlUiAllowedOrigins: ["https://app-v2-18789.k3s.example.test"],
					},
					providers: {
						default: {
							kind: "openai-compatible",
							baseUrl: "https://ai-gateway.example.test/v1",
							model: "gpt-5.4-mini",
							apiMode: "openai_chat",
							runtimeEnvName: "OPENAI_API_KEY",
							apiKeySecretRef: "secret://provider.default.apiKey",
						},
					},
				},
				egressProfiles: { profiles: [] },
				recovery: { cacheManifest: true, allowOfflineBoot: true },
			},
		};

		writeFileSync(configPatchFailure, "fail\n");
		const failedConfigPatch = convergeAndCommitTestRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(failedConfigPatch.installErrors).toContainEqual(
			expect.stringContaining("runtime openclaw provider projection failed"),
		);
		expect(failedConfigPatch.outputs.systemdUserUnits).toEqual([]);
		expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
			"stale-installer-token",
		);
		expect(readFileSync(openclawCommand, "utf8").trim()).toBe("config patch --stdin");
		expect(existsSync(installerToken)).toBe(false);
		expect(existsSync(unitPath)).toBe(false);
		expect(existsSync(gatewayEnvPath)).toBe(false);
		rmSync(configPatchFailure);

		const convergence = convergeAndCommitTestRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});

		expect(convergence.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf-8").trim().split("\n")).toEqual([
			"config patch --stdin",
			"config patch --stdin",
			"gateway install --force --json",
		]);
		expect(JSON.parse(readFileSync(join(root, "openclaw-patch-1.json"), "utf-8"))).toEqual({
			gateway: {
				mode: "local",
				port: 18789,
				bind: "lan",
				auth: {
					mode: "token",
					token: "gateway-token",
				},
				controlUi: {
					basePath: "/",
					allowedOrigins: ["https://app-v2-18789.k3s.example.test"],
					dangerouslyAllowHostHeaderOriginFallback: false,
					dangerouslyDisableDeviceAuth: true,
				},
			},
		});
		expect(readFileSync(installerToken, "utf8")).toBe("gateway-token\n");
		expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
			"gateway-token",
		);
		expect(readFileSync(openclawCommand, "utf8")).not.toContain("gateway-token");
		expect(readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway")).not.toContain(
			"OPENCLAW_GATEWAY_TOKEN",
		);
		const openclawDropIn = readFileSync(
			join(
				getRuntimePaths().systemdUserRoot,
				"openclaw-gateway.service.d",
				"10-clawdi-hosted.conf",
			),
			"utf8",
		);
		expect(openclawDropIn).not.toContain("\nExecStart=");
		expect(openclawDropIn).not.toContain("\nWorkingDirectory=");

		const fixedCredentialTime = new Date("2026-08-11T00:00:00.000Z");
		utimesSync(openclawConfig, fixedCredentialTime, fixedCredentialTime);
		utimesSync(gatewayEnvPath, fixedCredentialTime, fixedCredentialTime);
		const configMtime = statSync(openclawConfig).mtimeMs;
		const envMtime = statSync(gatewayEnvPath).mtimeMs;
		const commandsAfterConvergence = readFileSync(openclawCommand, "utf8");
		const idempotent = convergeAndCommitTestRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(idempotent.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf8")).toBe(commandsAfterConvergence);
		expect(statSync(openclawConfig).mtimeMs).toBe(configMtime);
		expect(statSync(gatewayEnvPath).mtimeMs).toBe(envMtime);

		rmSync(unitPath, { force: true });
		const reinstalled = convergeAndCommitTestRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(reinstalled.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf8").trim().split("\n").slice(-1)).toEqual([
			"gateway install --force --json",
		]);
		expect(readFileSync(installerToken, "utf8")).toBe("gateway-token\n");
		expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
			"gateway-token",
		);
		expect(statSync(openclawConfig).mtimeMs).toBe(configMtime);
		expect(statSync(gatewayEnvPath).mtimeMs).toBe(envMtime);

		if (!loaded.secretValues) throw new Error("expected runtime secret fixture");
		loaded.secretValues["secret://runtime/openclaw/gateway-token"] = "rotated-gateway-token";
		const rotated = convergeAndCommitTestRuntimeManifest(loaded, getRuntimePaths(), {
			executeOfficialServiceInstallers: true,
		});
		expect(rotated.installErrors).toEqual([]);
		expect(readFileSync(openclawCommand, "utf8").trim().split("\n").slice(-1)).toEqual([
			"config patch --stdin",
		]);
		expect(JSON.parse(readFileSync(openclawConfig, "utf8")).gateway.auth.token).toBe(
			"rotated-gateway-token",
		);
		expect(readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway")).not.toContain(
			"OPENCLAW_GATEWAY_TOKEN",
		);
		expect(readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway")).not.toContain(
			"rotated-gateway-token",
		);
		expect(readFileSync(openclawCommand, "utf8")).not.toContain("rotated-gateway-token");
	});

	it("owns one hosted Hermes OAuth family across rotation, logout, reconnect, and removal", () => {
		const home = join(root, "oauth-hermes", "home", "clawdi");
		const state = join(root, "oauth-hermes", "var", "lib", "clawdi");
		const run = join(root, "oauth-hermes", "run", "clawdi");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		writeHermesVersionBinary(home, "0.19.0");
		const paths = getRuntimePaths();
		const authPath = join(home, ".hermes", "auth.json");
		const nativeProfileId = nativeOAuthProfileId("hermes", "openai-codex");
		const ledgerKey = createHash("sha256").update("openai-codex").digest("hex");
		const ledgerPath = join(paths.oauthCredentialRoot, "hermes", `${ledgerKey}.json`);
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(
			authPath,
			`${JSON.stringify({
				version: 1,
				providers: {
					"openai-codex": {
						tokens: { access_token: "user-access", refresh_token: "user-refresh" },
					},
				},
				credential_pool: {
					"openai-codex": [
						{
							id: "user-independent",
							label: "user-independent",
							auth_type: "oauth",
							priority: 0,
							source: "manual:device_code",
							access_token: "user-independent-access",
							refresh_token: "user-independent-refresh",
						},
					],
				},
			})}\n`,
		);
		const firstLoad = hostedOAuthRuntimeLoad({
			home,
			runtime: "hermes",
			generation: 1,
			credentialRevision: "hermes-revision-1",
			accessToken: "hermes-seed-access",
			refreshToken: "hermes-seed-refresh",
		});
		mkdirSync(dirname(ledgerPath), { recursive: true });
		writeFileSync(
			ledgerPath,
			`${JSON.stringify({
				schemaVersion: "clawdi.oauthCredentialOwnership.v2",
				runtime: "hermes",
				providerId: "openai-codex",
				nativeProfileId,
				credentialRevision: "hermes-revision-1",
				state: "intent",
				operation: "seed",
				targetCredentialFingerprint: oauthCredentialFingerprint(
					"hermes-revision-1",
					"hermes-seed-access",
					"hermes-seed-refresh",
				),
			})}\n`,
		);

		const first = convergeRuntimeManifest(firstLoad, paths);
		expect(first.installErrors).toEqual([]);
		let auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.providers["openai-codex"].tokens.access_token).toBe("user-access");
		expect(auth.credential_pool["openai-codex"][0]).toMatchObject({
			id: nativeProfileId,
			label: "Clawdi managed connection",
			source: "manual:device_code",
			access_token: "hermes-seed-access",
			refresh_token: "hermes-seed-refresh",
		});
		expect(auth.credential_pool["openai-codex"][1].id).toBe("user-independent");
		expect(existsSync(join(home, ".hermes", "auth.lock"))).toBe(true);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("seeded");

		auth.credential_pool["openai-codex"][0].access_token = "hermes-runtime-rotated";
		auth.credential_pool["openai-codex"][0].refresh_token = "hermes-runtime-rotated-refresh";
		writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
		convergeRuntimeManifest(firstLoad, paths);
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.credential_pool["openai-codex"][0].access_token).toBe("hermes-runtime-rotated");
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("seeded");

		auth.credential_pool["openai-codex"] = auth.credential_pool["openai-codex"].filter(
			(entry: { id?: string }) => entry.id !== nativeProfileId,
		);
		writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
		convergeRuntimeManifest(firstLoad, paths);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
			nativeProfileId,
			credentialRevision: "hermes-revision-1",
			state: "revoked",
		});
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.credential_pool["openai-codex"][0].id).toBe("user-independent");
		convergeRuntimeManifest(firstLoad, paths);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("revoked");

		const nativeReauthenticatedLoad = hostedOAuthRuntimeLoad({
			home,
			runtime: "hermes",
			generation: 2,
			credentialRevision: "hermes-revision-2",
			accessToken: "explicit-reconnect-access",
			refreshToken: "explicit-reconnect-refresh",
		});
		convergeRuntimeManifest(nativeReauthenticatedLoad, paths);
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.providers["openai-codex"].tokens.access_token).toBe("user-access");
		expect(auth.credential_pool["openai-codex"][0]).toMatchObject({
			id: nativeProfileId,
			access_token: "explicit-reconnect-access",
			refresh_token: "explicit-reconnect-refresh",
		});
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
			credentialRevision: "hermes-revision-2",
			state: "seeded",
		});

		auth.credential_pool["openai-codex"][0].access_token = "post-reconnect-rotated-access";
		auth.credential_pool["openai-codex"][0].refresh_token = "post-reconnect-rotated-refresh";
		writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`);
		convergeRuntimeManifest(nativeReauthenticatedLoad, paths);
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.credential_pool["openai-codex"][0].access_token).toBe(
			"post-reconnect-rotated-access",
		);

		const removedLoad = hostedSingleProviderModeLoad(
			home,
			"hermes",
			"unmanaged",
			3,
			firstLoad.manifest.instanceId,
		);
		convergeRuntimeManifest(removedLoad, paths);
		auth = JSON.parse(readFileSync(authPath, "utf8"));
		expect(auth.providers["openai-codex"].tokens.access_token).toBe("user-access");
		expect(auth.credential_pool?.["openai-codex"]).toEqual([
			expect.objectContaining({
				id: "user-independent",
				access_token: "user-independent-access",
				refresh_token: "user-independent-refresh",
			}),
		]);
		expect(existsSync(ledgerPath)).toBe(false);
	}, 30_000);

	it("uses OpenClaw provider-auth SQLite ownership without reviving logout", () => {
		const home = join(root, "oauth-openclaw", "home", "clawdi");
		const state = join(root, "oauth-openclaw", "var", "lib", "clawdi");
		const run = join(root, "oauth-openclaw", "run", "clawdi");
		const sdkCalls = join(root, "oauth-openclaw", "provider-auth-calls.log");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = writeFakeOpenClawProviderAuthSdk(
			join(root, "oauth-openclaw"),
			sdkCalls,
		);
		seedOpenClawBinary(home);
		const paths = getRuntimePaths();
		const nativeProfileId = nativeOAuthProfileId("openclaw", "openai-codex");
		const ledgerKey = createHash("sha256").update("openai-codex").digest("hex");
		const ledgerPath = join(paths.oauthCredentialRoot, "openclaw", `${ledgerKey}.json`);
		const storePath = join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(
			storePath,
			`${JSON.stringify({
				profiles: {
					"openai:default": {
						type: "oauth",
						provider: "openai",
						access: "user-access",
						refresh: "user-refresh",
					},
				},
				order: { openai: ["openai:default"] },
				lastGood: {},
				usageStats: {},
			})}\n`,
		);
		const firstLoad = hostedOAuthRuntimeLoad({
			home,
			runtime: "openclaw",
			generation: 1,
			credentialRevision: "openclaw-revision-1",
			accessToken: "openclaw-seed-access",
			refreshToken: "openclaw-seed-refresh",
		});
		mkdirSync(dirname(ledgerPath), { recursive: true });
		writeFileSync(
			ledgerPath,
			`${JSON.stringify({
				schemaVersion: "clawdi.oauthCredentialOwnership.v2",
				runtime: "openclaw",
				providerId: "openai-codex",
				nativeProfileId,
				credentialRevision: "openclaw-revision-1",
				state: "intent",
				operation: "seed",
				targetCredentialFingerprint: oauthCredentialFingerprint(
					"openclaw-revision-1",
					"openclaw-seed-access",
					"openclaw-seed-refresh",
				),
			})}\n`,
		);

		const first = convergeRuntimeManifest(firstLoad, paths);
		expect(first.installErrors).toEqual([]);
		let store = JSON.parse(readFileSync(storePath, "utf8"));
		expect(store.profiles[nativeProfileId]).toMatchObject({
			type: "oauth",
			provider: "openai",
			access: "openclaw-seed-access",
			refresh: "openclaw-seed-refresh",
			copyToAgents: false,
		});
		expect(store.profiles["openai:default"]).toMatchObject({
			access: "user-access",
			refresh: "user-refresh",
		});
		expect(store.order.openai).toEqual([nativeProfileId, "openai:default"]);
		expect(existsSync(join(dirname(storePath), "auth-profiles.json"))).toBe(false);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("seeded");

		store.profiles[nativeProfileId].access = "openclaw-runtime-rotated";
		store.profiles[nativeProfileId].refresh = "openclaw-runtime-rotated-refresh";
		writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
		convergeRuntimeManifest(firstLoad, paths);
		expect(JSON.parse(readFileSync(storePath, "utf8")).profiles[nativeProfileId].access).toBe(
			"openclaw-runtime-rotated",
		);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("seeded");

		store = JSON.parse(readFileSync(storePath, "utf8"));
		delete store.profiles[nativeProfileId];
		writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
		convergeRuntimeManifest(firstLoad, paths);
		expect(JSON.parse(readFileSync(storePath, "utf8")).profiles[nativeProfileId]).toBeUndefined();
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
			nativeProfileId,
			credentialRevision: "openclaw-revision-1",
			state: "revoked",
		});

		store = JSON.parse(readFileSync(storePath, "utf8"));
		store.profiles["openai:default"].access = "native-reauth-access";
		store.profiles["openai:default"].refresh = "native-reauth-refresh";
		writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
		convergeRuntimeManifest(firstLoad, paths);
		expect(JSON.parse(readFileSync(ledgerPath, "utf8")).state).toBe("revoked");

		const nativeReauthenticatedLoad = hostedOAuthRuntimeLoad({
			home,
			runtime: "openclaw",
			generation: 2,
			credentialRevision: "openclaw-revision-2",
			accessToken: "explicit-reconnect-access",
			refreshToken: "explicit-reconnect-refresh",
		});
		convergeRuntimeManifest(nativeReauthenticatedLoad, paths);
		store = JSON.parse(readFileSync(storePath, "utf8"));
		expect(store.profiles["openai:default"].access).toBe("native-reauth-access");
		expect(store.profiles[nativeProfileId]).toMatchObject({
			access: "explicit-reconnect-access",
			refresh: "explicit-reconnect-refresh",
		});
		expect(JSON.parse(readFileSync(ledgerPath, "utf8"))).toMatchObject({
			credentialRevision: "openclaw-revision-2",
			state: "seeded",
		});

		store.profiles[nativeProfileId].access = "post-reconnect-rotated-access";
		store.profiles[nativeProfileId].refresh = "post-reconnect-rotated-refresh";
		store.lastGood = { openai: nativeProfileId };
		store.usageStats = { [nativeProfileId]: { lastUsed: 123 } };
		writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);
		convergeRuntimeManifest(nativeReauthenticatedLoad, paths);
		expect(JSON.parse(readFileSync(storePath, "utf8")).profiles[nativeProfileId].access).toBe(
			"post-reconnect-rotated-access",
		);

		const removedLoad = hostedSingleProviderModeLoad(
			home,
			"openclaw",
			"unmanaged",
			3,
			firstLoad.manifest.instanceId,
		);
		convergeRuntimeManifest(removedLoad, paths);
		store = JSON.parse(readFileSync(storePath, "utf8"));
		expect(store.profiles[nativeProfileId]).toBeUndefined();
		expect(store.profiles["openai:default"]).toMatchObject({
			access: "native-reauth-access",
			refresh: "native-reauth-refresh",
		});
		expect(store.order?.openai ?? []).not.toContain(nativeProfileId);
		expect(store.order?.openai ?? []).toEqual(["openai:default"]);
		expect(store.lastGood?.openai).toBeUndefined();
		expect(store.usageStats?.[nativeProfileId]).toBeUndefined();
		expect(existsSync(ledgerPath)).toBe(false);
		const calls = readFileSync(sdkCalls, "utf8");
		expect(calls).toContain("ensure ");
		expect(calls).toContain("update ");
	});

	it("does not reinstall an installed OpenClaw missing provider-auth capability", () => {
		const testRoot = join(root, "oauth-openclaw-capability-repair");
		const home = join(testRoot, "home", "clawdi");
		const state = join(testRoot, "var", "lib", "clawdi");
		const run = join(testRoot, "run", "clawdi");
		const installer = join(testRoot, "install-openclaw.sh");
		const installerLog = join(testRoot, "installer.log");
		const sdkTarget = join(testRoot, "installed-provider-auth.mjs");
		const sdkSource = writeFakeOpenClawProviderAuthSdk(
			join(testRoot, "repair-source"),
			join(testRoot, "provider-auth-calls.log"),
		);
		mkdirSync(testRoot, { recursive: true });
		writeFileSync(
			installer,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> '${installerLog}'
cp '${sdkSource}' '${sdkTarget}'
`,
		);
		chmodSync(installer, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = `file://${installer}`;
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = sdkTarget;
		seedOpenClawBinary(home);

		const loaded = hostedOAuthRuntimeLoad({
			home,
			runtime: "openclaw",
			generation: 1,
			credentialRevision: "repair-revision-1",
			accessToken: "repair-access",
			refreshToken: "repair-refresh",
		});
		const result = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(result.installErrors.join("\n")).toContain(
			"OpenClaw OAuth requires the public OpenClaw SDK; automatic runtime reinstall is disabled",
		);
		expect(existsSync(installerLog)).toBe(false);
		const storePath = join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
		expect(existsSync(storePath)).toBe(false);
	});

	it("fails closed before config or credential mutation when OpenClaw capability is unavailable", () => {
		const testRoot = join(root, "oauth-openclaw-capability-repair-failure");
		const home = join(testRoot, "home", "clawdi");
		const state = join(testRoot, "var", "lib", "clawdi");
		const run = join(testRoot, "run", "clawdi");
		const installer = join(testRoot, "install-openclaw-fail.sh");
		const sdkTarget = join(testRoot, "missing-provider-auth.mjs");
		mkdirSync(testRoot, { recursive: true });
		writeFileSync(installer, "#!/usr/bin/env bash\nexit 42\n");
		chmodSync(installer, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_RUNTIME_ALLOW_TEST_INSTALLERS = "1";
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_INSTALLER = `file://${installer}`;
		process.env.CLAWDI_RUNTIME_TEST_OPENCLAW_PROVIDER_AUTH_SDK = sdkTarget;
		seedOpenClawBinary(home);
		const configPath = join(home, ".openclaw", "openclaw.json");
		const storePath = join(home, ".openclaw", "agents", "main", "agent", "openclaw-agent.sqlite");
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(configPath, '{"original":true}\n');
		writeFileSync(
			storePath,
			'{"profiles":{"openai:default":{"type":"oauth","provider":"openai","access":"user-access","refresh":"user-refresh"}},"order":{"openai":["openai:default"]}}\n',
		);
		const originalConfig = readFileSync(configPath, "utf8");
		const originalStore = readFileSync(storePath, "utf8");
		const loaded = hostedOAuthRuntimeLoad({
			home,
			runtime: "openclaw",
			generation: 1,
			credentialRevision: "repair-failure-revision",
			accessToken: "must-not-write-access",
			refreshToken: "must-not-write-refresh",
		});

		const result = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(result.installErrors.join("\n")).toContain("automatic runtime reinstall is disabled");
		expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
		expect(readFileSync(storePath, "utf8")).toBe(originalStore);
		expect(existsSync(join(getRuntimePaths().oauthCredentialRoot, "openclaw"))).toBe(false);
	});
});
