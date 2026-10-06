import { describe, expect, it } from "bun:test";

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";

import { dirname, join } from "node:path";

import { readRuntimeAppliedState, runtimeContentSha256 } from "../src/runtime/applied-state";

import { materializeHostedChannelCredentials } from "../src/runtime/manifest";

import {
	HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
	type RuntimeBundleChannelBinding,
	type RuntimeManifestLoad,
} from "../src/runtime/manifest-source";

import { getRuntimePaths } from "../src/runtime/paths";

import {
	applySystemdRuntimeUpdate,
	readSystemdUnitSnapshot,
} from "../src/runtime/systemd-transaction";

import { writeFakeOpenClawConfigMutationSdk } from "../src/test-support/openclaw-config-mutation";

import {
	applyRuntimeBundleChannelsToManifestLoad,
	CANONICAL_TEST_CONTEXT,
	convergeAndCommitTestRuntimeManifest,
	convergeRuntimeManifest,
	fakeOpenClawConfigPatchCommand,
	fakeSystemdStatePath,
	hermesManagedBaileysRoot,
	hostedChannelBundleLoad,
	hostedOpenClawRuntime,
	hostedRequiredState,
	hostedRuntimeBundleResponse,
	hostedSingleProviderModeLoad,
	hostedSystemFixture,
	installRuntimeTestHooks,
	installSuccessfulSystemctlFixture,
	openClawDiscordPluginInspectFixture,
	openClawWhatsAppPluginInspectFixture,
	readHermesConfigYaml,
	readSystemdEnvFile,
	root,
	runtimeInit,
	seedCurrentCliInstall,
	seedFakeSystemdSnapshotProcesses,
	seedHermesManagedBaileys,
	seedManagedBaileysArtifact,
	seedMitmproxyCache,
	setRuntimeApplyGeneration,
	systemdEnvDigest,
	TEST_HOSTED_LOCALE,
	TEST_PROCESS_USER,
	TEST_RUNNING_CLI_SPEC,
	TEST_RUNNING_CLI_VERSION,
	testBundleEtag,
	writeFakeSystemdManager,
	writeHermesVersionBinary,
	writeTestRuntimeAppliedState,
} from "../src/test-support/runtime-harness";

import { mockFetch } from "./commands/helpers";

installRuntimeTestHooks();

describe("runtime manifest datasource", () => {
	it("reconciles environment-scoped hosted bundle channel create, rotation, and removal", () => {
		const accountKey = "clawdi_00000000000000000000000000000001";
		const agentRef = `secret://channels/telegram/${accountKey}/agent-token`;
		const placeholderRef = `secret://channels/telegram/${accountKey}/placeholder-token`;
		const placeholder = "999999999:0123456789abcdef0123456789abcdef";
		const base: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_bundle_channel",
				environmentId: "env_bundle_channel",
				instanceId: "iid_bundle_channel",
				generation: 1,
				issuedAt: "2026-07-30T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: { openclaw: { enabled: true }, hermes: { enabled: false } },
			},
			source: "remote-datasource",
			sourcePath: "https://cloud-api.test/v1/runtime/manifest",
			offline: false,
		};
		const binding: RuntimeBundleChannelBinding = {
			provider: "telegram",
			accountKey,
			agentTokenSecretRef: agentRef,
			placeholderTokenSecretRef: placeholderRef,
		};
		const active = applyRuntimeBundleChannelsToManifestLoad({
			...base,
			channelBindings: [binding],
			secretValues: { [agentRef]: "agent-token-v1", [placeholderRef]: placeholder },
			sourceRevision: "a".repeat(64),
		});
		const rotated = applyRuntimeBundleChannelsToManifestLoad({
			...base,
			channelBindings: [binding],
			secretValues: { [agentRef]: "agent-token-v2", [placeholderRef]: placeholder },
			sourceRevision: "b".repeat(64),
		});
		const removed = applyRuntimeBundleChannelsToManifestLoad({
			...base,
			channelBindings: [],
			secretValues: {},
			sourceRevision: "c".repeat(64),
		});

		expect(active.manifest.projection?.channels).toMatchObject({
			telegram: { defaultAccount: accountKey, accounts: { [accountKey]: { enabled: true } } },
		});
		expect(active.manifest.egressProfiles?.profiles).toHaveLength(2);
		expect(JSON.stringify(active.manifest)).not.toContain("agent-token-v1");
		expect(JSON.stringify(active)).not.toContain("provider-token");
		expect(rotated.sourceRevision).toBe("b".repeat(64));
		expect(rotated.secretValues?.[agentRef]).toBe("agent-token-v2");
		expect(removed.manifest.projection?.channels).toEqual({});
		expect(removed.manifest.egressProfiles?.profiles).toEqual([]);
		expect(removed.manifest.runtimes.openclaw?.run?.secretEnv ?? {}).toEqual({});
		expect(removed.secretValues).toEqual({});
	});

	it("removes stale channel-driven egress profiles when runtime channels are disabled", () => {
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				runtime: "openclaw",
				deploymentId: "dep_stale_channels",
				environmentId: "env_stale_channels",
				instanceId: "iid_stale_channels",
				generation: 4,
				issuedAt: "2026-06-14T00:00:00Z",
				system: { home: "/home/clawdi", workspace: "/home/clawdi" },
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: { enabled: true },
				},
				egressProfiles: {
					profiles: [
						{
							id: "native-discord-clawdi_acct1-gateway-passthrough",
							enabled: true,
							kind: "passthrough",
							match: {
								scheme: "wss",
								host: "gateway.discord.gg",
								pathPrefix: "/",
								headers: {},
								query: {},
							},
							logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
							priority: 201,
							owner: "clawdi-native-channels",
						},
						{
							id: "explicit-provider-profile",
							enabled: true,
							kind: "passthrough",
							match: {
								scheme: "https",
								host: "api.openai.com",
								pathPrefix: "/",
								headers: {},
								query: {},
							},
							logging: { redactHeaders: ["authorization"], redactUrlPatterns: [] },
							priority: 250,
						},
					],
				},
			},
			source: "remote-datasource",
			sourcePath: "https://runtime.test/manifest",
			secretValues: { "secret://provider.default.apiKey": "sk-provider" },
			channelBindings: [],
		};

		const projected = applyRuntimeBundleChannelsToManifestLoad(loaded);

		expect(projected.manifest.egressProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"explicit-provider-profile",
		]);
	});

	it("keeps managed channels separate from provider projection profiles", () => {
		const accountKey = "clawdi_accttelegram";
		const agentTokenSecretRef = `secret://channels/telegram/${accountKey}/agent-token`;
		const placeholderTokenSecretRef = `secret://channels/telegram/${accountKey}/placeholder-token`;
		const loaded: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_channel_provider",
				environmentId: "env_channel_provider",
				instanceId: "iid_channel_provider",
				generation: 3,
				issuedAt: "2026-06-14T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: { enabled: true },
					hermes: { enabled: false },
				},
				projection: {
					providers: {
						openclaw: {
							baseUrl: "https://openclaw-provider.example.test/v1",
							apiMode: "openai_chat",
							apiKeySecretRef: "secret://provider.openclaw.apiKey",
						},
						hermes: {
							baseUrl: "https://hermes-provider.example.test/v1",
							apiMode: "openai_responses",
							apiKeySecretRef: "secret://provider.hermes.apiKey",
						},
					},
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "https://runtime.test/manifest",
			secretValues: {
				"secret://provider.openclaw.apiKey": "sk-openclaw-provider",
				"secret://provider.hermes.apiKey": "sk-hermes-provider",
				[agentTokenSecretRef]: "agent-token-runtime",
				[placeholderTokenSecretRef]: "999999999:0123456789abcdef0123456789abcdef",
			},
			channelBindings: [
				{
					provider: "telegram",
					accountKey,
					agentTokenSecretRef,
					placeholderTokenSecretRef,
				},
			],
		};

		const projected = applyRuntimeBundleChannelsToManifestLoad(loaded);

		expect(projected.manifest.egressProfiles?.profiles.map((profile) => profile.id)).toEqual([
			"native-telegram-clawdi_accttelegram-managed",
			"native-telegram-clawdi_accttelegram-file-managed",
		]);
	});

	it.each(["missing", "unhealthy", "default"])(
		"runtime init publishes gated initial health without replacing %s watcher authority",
		async (watchState) => {
			installSuccessfulSystemctlFixture();
			setRuntimeApplyGeneration(7, CANONICAL_TEST_CONTEXT);
			const home = join(root, "home", "clawdi");
			const state = join(root, "var", "lib", "clawdi");
			const run = join(root, "run", "clawdi");
			const policyPath = join(root, "etc", "clawdi", "host-policy.json");
			const openclawBin = join(home, ".local", "bin", "openclaw");
			const openclawUnit = join(home, ".config", "systemd", "user", "openclaw-gateway.service");
			const openclawPluginInstalls = join(root, "openclaw-plugin-installs.txt");
			const openclawPluginSource = join(home, ".openclaw", "extensions", "discord", "index.js");
			const previousExitCode = process.exitCode;
			const previousLog = console.log;
			const logs: string[] = [];
			mkdirSync(join(run, "secrets"), { recursive: true });
			mkdirSync(join(home, ".local", "bin"), { recursive: true });
			mkdirSync(join(home, ".openclaw"), { recursive: true });
			mkdirSync(join(root, "etc", "clawdi"), { recursive: true });
			writeFakeOpenClawConfigMutationSdk(home);
			writeFileSync(
				join(home, ".openclaw", "openclaw.json"),
				`${JSON.stringify(
					{
						channels: {
							discord: {
								accounts: {
									clawdi_acctdiscord1: {
										enabled: false,
										token: "user-token",
										dmPolicy: "allowlist",
										allowFrom: ["discord-user"],
										guilds: { "discord-guild": { requireMention: true } },
									},
									personal: { enabled: true, token: "personal-token" },
								},
							},
						},
					},
					null,
					2,
				)}\n`,
			);
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
if [ "$*" = "plugins install --help" ]; then
  printf '%s\\n' '--accept-capabilities'
  exit 0
fi
${fakeOpenClawConfigPatchCommand(join(home, ".openclaw", "openclaw.json"))}
if [ "$*" = "plugins install @openclaw/discord --force --accept-capabilities" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  mkdir -p '${dirname(openclawPluginSource)}'
  printf '%s\\n' 'export const discordPlugin = true;' > '${openclawPluginSource}'
  exit 0
fi
if [ "$*" = "plugins inspect discord --json" ]; then
  printf '%s\\n' '${JSON.stringify(openClawDiscordPluginInspectFixture(openclawPluginSource))}'
  exit 0
fi
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
			writeFileSync(
				policyPath,
				JSON.stringify({
					schemaVersion: "clawdi.hostPolicy.v1",
					mode: "hosted-runtime",
					cliUpdateMode: "system-managed-npm",
					deniedCommands: ["setup", "teardown", "update"],
				}),
			);
			writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
			process.env.HOME = home;
			process.env.CLAWDI_RUNTIME_MODE = "hosted";
			process.env.CLAWDI_SERVICE_STATE_DIR = state;
			process.env.CLAWDI_RUN_DIR = run;
			process.env.CLAWDI_HOST_POLICY_PATH = policyPath;
			process.exitCode = undefined;
			console.log = (value?: unknown) => {
				logs.push(String(value));
			};
			seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
			const paths = getRuntimePaths();
			const { captured, restore } = mockFetch([
				{
					method: "GET",
					path: "/v1/runtime/manifest",
					response: () =>
						hostedRuntimeBundleResponse(
							{
								manifest: {
									schemaVersion: "clawdi.hosted-runtime.manifest.v1",
									runtime: "openclaw",
									deploymentId: "dep_init",
									environmentId: "env_init",
									...hostedRequiredState(),
									instanceId: "iid_init",
									generation: 7,
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
										openclaw: hostedOpenClawRuntime(),
									},
								},
								channelBindings: [
									{
										provider: "telegram",
										accountKey: "clawdi_accttelegram",
										agentTokenSecretRef:
											"secret://channels/telegram/clawdi_accttelegram/agent-token",
										placeholderTokenSecretRef:
											"secret://channels/telegram/clawdi_accttelegram/placeholder-token",
									},
									{
										provider: "discord",
										accountKey: "clawdi_acctdiscord1",
										agentTokenSecretRef:
											"secret://channels/discord/clawdi_acctdiscord1/agent-token",
										placeholderTokenSecretRef:
											"secret://channels/discord/clawdi_acctdiscord1/placeholder-token",
									},
								],
								secretValues: {
									"secret://channels/telegram/clawdi_accttelegram/agent-token": "agent-token-init",
									"secret://channels/telegram/clawdi_accttelegram/placeholder-token":
										"999999999:00000000000000000000000000000000",
									"secret://channels/discord/clawdi_acctdiscord1/agent-token":
										"discord-agent-token-init",
									"secret://channels/discord/clawdi_acctdiscord1/placeholder-token":
										"clawdi_00000000000000000000000000000000",
								},
							},
							{ etag: testBundleEtag("manifest-etag-init-7") },
						),
				},
			]);

			try {
				await runtimeInit({ nonInteractive: true, json: true });
				expect(process.exitCode).toBe(23);
				expect(JSON.parse(logs.at(-1) ?? "{}").errors.join("\n")).toContain("ownership changed");
				expect(readRuntimeAppliedState(paths)).toBeNull();
				const configPath = join(home, ".openclaw", "openclaw.json");
				const native = JSON.parse(readFileSync(configPath, "utf8"));
				expect(native.channels.discord.accounts.clawdi_acctdiscord1.token).toBe("user-token");
				expect(native.channels.discord.accounts.personal).toEqual({
					enabled: true,
					token: "personal-token",
				});
				// Explicit native credential selection resolves the collision; convergence must retain policies.
				native.channels.discord.accounts.clawdi_acctdiscord1.token = {
					source: "env",
					provider: "default",
					id: "CLAWDI_CHANNEL_DISCORD_CLAWDI_ACCTDISCORD1_AGENT_TOKEN",
				};
				writeFileSync(configPath, JSON.stringify(native));
				process.exitCode = undefined;
				const existingWatch = JSON.stringify({
					event: { status: "error", stage: "final", errors: ["previous failure"] },
				});
				if (watchState === "unhealthy") writeFileSync(paths.runtimeWatchStatus, existingWatch);
				if (watchState !== "default") process.env.CLAWDI_RUNTIME_OPENCLAW_HOT_APPLY = "1";
				await runtimeInit({ nonInteractive: true, json: true });
				if (watchState === "unhealthy")
					expect(readFileSync(paths.runtimeWatchStatus, "utf8")).toBe(existingWatch);
				else if (watchState === "default") expect(existsSync(paths.runtimeWatchStatus)).toBe(false);
				else {
					const applied = readRuntimeAppliedState(paths);
					expect(JSON.parse(readFileSync(paths.runtimeWatchStatus, "utf8")).event).toMatchObject({
						status: "applied",
						generation: 7,
						etag: applied?.etag,
						sourceRevision: applied?.sourceRevision,
						instanceId: applied?.instanceId,
						selfReexec: false,
					});
				}

				if (process.exitCode !== undefined && process.exitCode !== 0) {
					throw new Error(logs.join("\n"));
				}
				expect(process.exitCode).toBe(0);
				expect(captured).toHaveLength(2);
				expect(captured[0].path).toBe("/v1/runtime/manifest");
				expect(readRuntimeAppliedState(paths)).toMatchObject({
					etag: testBundleEtag("manifest-etag-init-7"),
					generation: 7,
				});
				expect(existsSync(join(state, "cache", "manifest.etag"))).toBe(false);
				const nativeConfigText = readFileSync(configPath, "utf8");
				const nativeConfig = JSON.parse(nativeConfigText);
				expect(nativeConfigText).not.toContain("agent-token-init");
				expect(nativeConfigText).not.toContain("discord-agent-token-init");
				expect(nativeConfig.channels.telegram.accounts.clawdi_accttelegram.botToken).toEqual({
					source: "env",
					provider: "default",
					id: "CLAWDI_CHANNEL_TELEGRAM_CLAWDI_ACCTTELEGRAM_AGENT_TOKEN",
				});
				expect(nativeConfig.secrets.providers.default).toEqual({ source: "env" });
				expect(nativeConfig.plugins.entries).toMatchObject({
					telegram: { enabled: true },
					discord: { enabled: true },
				});
				expect(nativeConfig.session.dmScope).toBe("per-account-channel-peer");
				expect(nativeConfig.channels).not.toHaveProperty("streaming");
				const discordAccounts = nativeConfig.channels.discord.accounts;
				const discordAccount = discordAccounts.clawdi_acctdiscord1;
				expect(discordAccount).toMatchObject({
					enabled: true,
					token: {
						source: "env",
						provider: "default",
						id: "CLAWDI_CHANNEL_DISCORD_CLAWDI_ACCTDISCORD1_AGENT_TOKEN",
					},
					dmPolicy: "allowlist",
					allowFrom: ["discord-user"],
					guilds: { "discord-guild": { requireMention: true } },
				});
				expect(Object.keys(discordAccounts).sort()).toEqual(["clawdi_acctdiscord1", "personal"]);
				expect(discordAccounts.personal).toEqual({ enabled: true, token: "personal-token" });
				expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe(
					"plugins install @openclaw/discord --force --accept-capabilities\n",
				);
				const openclawRunConfig = JSON.parse(
					readFileSync(join(getRuntimePaths().runConfigRoot, "openclaw.json"), "utf-8"),
				);
				expect(openclawRunConfig.secretEnv).toMatchObject({
					CLAWDI_CHANNEL_TELEGRAM_CLAWDI_ACCTTELEGRAM_AGENT_TOKEN:
						"secret://channels/telegram/clawdi_accttelegram/placeholder-token",
					CLAWDI_CHANNEL_DISCORD_CLAWDI_ACCTDISCORD1_AGENT_TOKEN:
						"secret://channels/discord/clawdi_acctdiscord1/placeholder-token",
				});
				expect(existsSync(join(run, "secrets", "runtime-secrets.json"))).toBe(false);
				const gatewayEnv = readSystemdEnvFile(getRuntimePaths(), "openclaw-gateway");
				expect(gatewayEnv).toContain("999999999:00000000000000000000000000000000");
				expect(gatewayEnv).toContain("clawdi_00000000000000000000000000000000");
				expect(gatewayEnv).not.toContain("agent-token-init");
				expect(gatewayEnv).not.toContain("discord-agent-token-init");
				const egressSecretsText = readFileSync(
					join(run, "secrets", "egress-secrets.json"),
					"utf-8",
				);
				expect(egressSecretsText).toContain("agent-token-init");
				expect(egressSecretsText).toContain("discord-agent-token-init");
				const cachedManifestText = readFileSync(paths.manifestLastGood, "utf-8");
				const cachedManifest = JSON.parse(cachedManifestText);
				expect(cachedManifest).toMatchObject({
					schemaVersion: "clawdi.hosted-runtime.bundle.v2",
					manifest: {
						schemaVersion: "clawdi.hosted-runtime.manifest.v1",
						generation: 7,
					},
					channelBindings: [{ provider: "telegram" }, { provider: "discord" }],
					secretValues: {},
				});
				expect(cachedManifestText).not.toContain("agent-token-init");
				expect(cachedManifestText).not.toContain("discord-agent-token-init");
				expect(statSync(paths.manifestLastGood).mode & 0o777).toBe(0o600);
				const cachedSecretsText = readFileSync(paths.managedSecretCacheFile, "utf-8");
				expect(cachedSecretsText).toContain("placeholder-token");
				expect(cachedSecretsText).toContain("999999999:");
				expect(cachedSecretsText).toContain("clawdi_");
				expect(cachedSecretsText).toContain("agent-token-init");
				expect(cachedSecretsText).toContain("discord-agent-token-init");
				expect(statSync(paths.managedSecretCacheFile).mode & 0o777).toBe(0o600);
				const profileBundleText = readFileSync(getRuntimePaths().egressProfileBundle, "utf-8");
				const profileBundle = JSON.parse(profileBundleText) as {
					profiles: Array<Record<string, unknown>>;
				};
				const telegramProfiles = profileBundle.profiles.filter((profile) =>
					String(profile.id).startsWith("native-telegram-"),
				);
				expect(telegramProfiles).toHaveLength(2);
				expect(telegramProfiles.map((profile) => profile.match)).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ pathPrefix: "/bot" }),
						expect.objectContaining({ pathPrefix: "/file/bot" }),
					]),
				);
				for (const profile of telegramProfiles) {
					const rewrite = profile.rewrite as Record<string, unknown>;
					expect(rewrite.pathReplace).toBeUndefined();
					expect(rewrite.setHeaders).toEqual({
						authorization: {
							type: "secretRef",
							secretRef: "secret://channels/telegram/clawdi_accttelegram/agent-token",
							prefix: "Bearer ",
						},
					});
				}
				expect(profileBundleText).not.toContain("agent-token-init");
				expect(profileBundleText).not.toContain("replacementSecretRef");
				expect(profileBundleText).toContain("placeholder-token");
				const status = JSON.parse(logs.at(-1) ?? "{}");
				expect(status.status).toBe("ok");
				expect(status.activeGeneration).toBe(7);
			} finally {
				restore();
				console.log = previousLog;
				process.exitCode = previousExitCode;
			}
		},
	);

	it("runtime init records malformed bundle channel references as a boot error", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const policyPath = join(root, "etc", "clawdi", "host-policy.json");
		const previousExitCode = process.exitCode;
		const previousLog = console.log;
		const logs: string[] = [];
		const bundle = JSON.parse(
			readFileSync(
				join(import.meta.dir, "../../../test-fixtures/runtime-bundle-v2.golden.json"),
				"utf-8",
			),
		) as {
			applyGeneration: number;
			sourceRevision: string;
			manifest: {
				clawdiCli: { packageSpec: string };
				runtime: string;
				system: Record<string, unknown>;
				runtimes: Record<string, unknown>;
			};
			channelBindings: Array<{ agentTokenSecretRef: string }>;
			secretValues: Record<string, string>;
		};
		const missingSecretRef = bundle.channelBindings[0]?.agentTokenSecretRef;
		if (!missingSecretRef) throw new Error("golden bundle has no channel binding");
		bundle.manifest.clawdiCli.packageSpec = TEST_RUNNING_CLI_SPEC;
		delete bundle.secretValues[missingSecretRef];
		bundle.sourceRevision = runtimeContentSha256({
			manifest: bundle.manifest,
			channelBindings: bundle.channelBindings,
			secretValues: bundle.secretValues,
		});
		setRuntimeApplyGeneration(bundle.applyGeneration);

		mkdirSync(join(run, "secrets"), { recursive: true });
		mkdirSync(dirname(policyPath), { recursive: true });
		writeFileSync(
			policyPath,
			JSON.stringify({
				schemaVersion: "clawdi.hostPolicy.v1",
				mode: "hosted-runtime",
				cliUpdateMode: "system-managed-npm",
				deniedCommands: ["setup", "teardown", "update"],
			}),
		);
		writeFileSync(join(run, "secrets", "auth-token"), "file-runtime-token\n");
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_RUNTIME_HOME = home;
		process.env.CLAWDI_HOST_POLICY_PATH = policyPath;
		seedCurrentCliInstall(state, TEST_RUNNING_CLI_VERSION);
		process.exitCode = undefined;
		console.log = (value?: unknown) => {
			logs.push(String(value));
		};
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/v1/runtime/manifest",
				response: () =>
					new Response(JSON.stringify(bundle), {
						status: 200,
						headers: {
							"content-type": HOSTED_RUNTIME_BUNDLE_V2_MEDIA_TYPE,
							etag: `"sha256:${bundle.sourceRevision}"`,
						},
					}),
			},
		]);

		try {
			await runtimeInit({ nonInteractive: true, json: true });

			const paths = getRuntimePaths();
			const status = JSON.parse(logs[0] ?? "{}");
			expect(status.status).toBe("error");
			expect(status.error).toContain(`runtime bundle is missing ${missingSecretRef}`);
			expect(status.stage).toBe("final");
			expect(process.exitCode).toBe(23);
			expect(JSON.parse(readFileSync(paths.bootStatus, "utf-8"))).toEqual(status);
			expect(existsSync(paths.appliedState)).toBe(false);
		} finally {
			restore();
			console.log = previousLog;
			process.exitCode = previousExitCode;
		}
	});

	it("keeps hosted Hermes channel projection under runtime HOME", () => {
		const home = join(root, "home", "clawdi");
		const ambientHome = join(root, "ambient-home");
		const ambientHermesConfig = join(ambientHome, ".hermes", "config.yaml");
		const ambientSentinel = "ambient-sentinel: unchanged\n";
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const hermesBin = join(home, ".local", "bin", "hermes");
		mkdirSync(dirname(hermesBin), { recursive: true });
		mkdirSync(join(home, ".hermes"), { recursive: true });
		mkdirSync(dirname(ambientHermesConfig), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeHermesVersionBinary(home, "0.20.1");
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			[
				"custom_root: keep",
				"group_sessions_per_user: false",
				"thread_sessions_per_user: true",
				"streaming:",
				"  enabled: false",
				"telegram:",
				"  dm_policy: allowlist",
				"  group_policy: allowlist",
				'  allow_from: ["telegram-user"]',
				'  group_allow_from: ["telegram-group-user"]',
				'  group_allowed_chats: ["telegram-chat"]',
				"  require_mention: true",
				"  extra:",
				"    base_url: https://telegram.example.test/bot",
				"    base_file_url: https://telegram.example.test/file/bot",
				"discord:",
				"  dm_policy: pairing",
				"  group_policy: allowlist",
				'  allow_from: ["discord-user"]',
				'  group_allow_from: ["discord-group-user"]',
				"  require_mention: true",
				"  thread_require_mention: true",
				"  bots_require_inline_mention: true",
				'  free_response_channels: "123456789"',
				"  auto_thread: true",
				"display:",
				"  theme: user-theme",
				"  platforms:",
				"    discord:",
				"      streaming: false",
				"    telegram:",
				"      compact: true",
				"      streaming: false",
				"platforms:",
				"  telegram:",
				"    custom: keep-telegram",
				"    extra:",
				"      custom_extra: keep-extra",
				"      group_sessions_per_user: true",
				"      thread_sessions_per_user: true",
				"  discord:",
				"    custom: keep-discord",
				"",
			].join("\n"),
		);
		writeFileSync(ambientHermesConfig, ambientSentinel);
		process.env.HOME = ambientHome;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_HOME = home;
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		const paths = getRuntimePaths();
		const telegramAccountKey = "clawdi_accttelegram";
		const telegramAgentRef = `secret://channels/telegram/${telegramAccountKey}/agent-token`;
		const telegramPlaceholderRef = `secret://channels/telegram/${telegramAccountKey}/placeholder-token`;
		const discordAccountKey = "clawdi_acctdiscordh";
		const discordAgentRef = `secret://channels/discord/${discordAccountKey}/agent-token`;
		const discordPlaceholderRef = `secret://channels/discord/${discordAccountKey}/placeholder-token`;
		const telegramBinding: RuntimeBundleChannelBinding = {
			provider: "telegram",
			accountKey: telegramAccountKey,
			agentTokenSecretRef: telegramAgentRef,
			placeholderTokenSecretRef: telegramPlaceholderRef,
		};
		const discordBinding: RuntimeBundleChannelBinding = {
			provider: "discord",
			accountKey: discordAccountKey,
			agentTokenSecretRef: discordAgentRef,
			placeholderTokenSecretRef: discordPlaceholderRef,
		};

		const load: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				runtime: "hermes",
				deploymentId: "dep_hermes_channels",
				environmentId: "env_hermes_channels",
				instanceId: "iid_hermes_channels",
				generation: 12,
				issuedAt: "2026-07-07T00:00:00Z",
				workspaceRoot: workspace,
				controlPlane: { apiUrl: "https://cloud-api.test/" },
				egressEngine: seedMitmproxyCache(paths),
				runtimes: {
					hermes: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://hermes-agent.nousresearch.com/install.sh",
							home,
							args: [],
						},
						run: {
							args: ["gateway", "run"],
							env: {
								HERMES_EXISTING_ENV: "kept",
								WHATSAPP_ENABLED: "stale",
							},
							prependPath: [],
						},
						services: {},
					},
				},
				projection: {
					system: {},
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://hermes-channels",
			offline: false,
			secretValues: {
				[telegramAgentRef]: "123456789:telegram-agent-token",
				[telegramPlaceholderRef]: `999999999:${"a".repeat(32)}`,
				[discordAgentRef]: "discord-agent-token",
				[discordPlaceholderRef]: `clawdi_${"b".repeat(32)}`,
			},
			channelBindings: [telegramBinding, discordBinding],
		};

		const projected = applyRuntimeBundleChannelsToManifestLoad(load, paths);
		const convergence = convergeRuntimeManifest(projected, paths);

		expect(convergence.installErrors).toEqual([]);
		expect(paths.userHome).toBe(home);
		expect(readFileSync(ambientHermesConfig, "utf-8")).toBe(ambientSentinel);
		const hermesConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf-8");
		expect(hermesConfig).toContain("telegram:");
		expect(hermesConfig).toContain("enabled: true");
		expect(hermesConfig).toContain("discord:");
		expect(hermesConfig).toContain("thread_require_mention: true");
		expect(hermesConfig).not.toContain("telegram-agent-token");
		expect(hermesConfig).not.toContain("discord-agent-token");
		const parsedHermesConfig = readHermesConfigYaml(home);
		expect(parsedHermesConfig.streaming).toEqual({ enabled: false });
		expect(parsedHermesConfig.group_sessions_per_user).toBe(false);
		expect(parsedHermesConfig.thread_sessions_per_user).toBe(true);
		expect(parsedHermesConfig.telegram).toMatchObject({
			enabled: true,
			dm_policy: "allowlist",
			group_policy: "allowlist",
			allow_from: ["telegram-user"],
			group_allow_from: ["telegram-group-user"],
			group_allowed_chats: ["telegram-chat"],
			require_mention: true,
			extra: {
				base_url: "https://telegram.example.test/bot",
				base_file_url: "https://telegram.example.test/file/bot",
			},
		});
		expect(parsedHermesConfig.discord).toMatchObject({
			dm_policy: "pairing",
			group_policy: "allowlist",
			allow_from: ["discord-user"],
			group_allow_from: ["discord-group-user"],
			require_mention: true,
			thread_require_mention: true,
			bots_require_inline_mention: true,
			free_response_channels: "123456789",
			auto_thread: true,
		});
		expect(parsedHermesConfig).not.toHaveProperty("streaming.transport");
		expect(parsedHermesConfig).toMatchObject({
			custom_root: "keep",
			display: {
				theme: "user-theme",
				platforms: {
					discord: { streaming: false },
					telegram: { compact: true, streaming: false },
				},
			},
			platforms: {
				telegram: {
					custom: "keep-telegram",
					extra: {
						custom_extra: "keep-extra",
						group_sessions_per_user: true,
						thread_sessions_per_user: true,
					},
				},
				discord: { custom: "keep-discord" },
			},
		});

		const runConfig = JSON.parse(
			readFileSync(join(getRuntimePaths().runConfigRoot, "hermes.json"), "utf-8"),
		);
		expect(runConfig.env.HERMES_EXISTING_ENV).toBe("kept");
		expect(runConfig.env.TELEGRAM_ALLOW_ALL_USERS).toBe("true");
		expect(runConfig.env.DISCORD_ALLOW_ALL_USERS).toBe("true");
		expect(runConfig.env.HERMES_TELEGRAM_DISABLE_FALLBACK_IPS).toBe("true");
		expect(runConfig.secretEnv.TELEGRAM_BOT_TOKEN).toMatch(
			/^secret:\/\/channels\/telegram\/clawdi_accttelegram\/placeholder-token$/,
		);
		expect(runConfig.secretEnv.DISCORD_BOT_TOKEN).toMatch(
			/^secret:\/\/channels\/discord\/clawdi_acctdiscordh\/placeholder-token$/,
		);
		const hermesEnv = readSystemdEnvFile(getRuntimePaths(), "hermes-gateway");
		expect(hermesEnv).toMatch(/TELEGRAM_BOT_TOKEN="999999999:[a-f0-9]{32}"/);
		expect(hermesEnv).toMatch(/DISCORD_BOT_TOKEN="clawdi_[a-f0-9]{32}"/);
		expect(hermesEnv).not.toContain("telegram-agent-token");
		expect(hermesEnv).not.toContain("discord-agent-token");
		expect(hermesEnv).toContain('TELEGRAM_ALLOW_ALL_USERS="true"');
		expect(hermesEnv).toContain('DISCORD_ALLOW_ALL_USERS="true"');
		expect(hermesEnv).toContain('HERMES_TELEGRAM_DISABLE_FALLBACK_IPS="true"');
		const profileBundle = readFileSync(getRuntimePaths().egressProfileBundle, "utf-8");
		expect(profileBundle).toContain("/v1/channels/telegram");
		expect(profileBundle).toContain("/v1/channels/discord");

		const discordOnly = convergeRuntimeManifest(
			applyRuntimeBundleChannelsToManifestLoad(
				{ ...load, channelBindings: [discordBinding] },
				paths,
			),
			paths,
		);
		expect(discordOnly.installErrors).toEqual([]);
		const discordOnlyHermesConfig = readHermesConfigYaml(home);
		expect(discordOnlyHermesConfig.group_sessions_per_user).toBe(false);
		expect(discordOnlyHermesConfig.thread_sessions_per_user).toBe(true);
		expect(discordOnlyHermesConfig.telegram).toMatchObject({
			enabled: true,
			dm_policy: "allowlist",
			group_policy: "allowlist",
			allow_from: ["telegram-user"],
			group_allow_from: ["telegram-group-user"],
			group_allowed_chats: ["telegram-chat"],
			require_mention: true,
		});
		expect(discordOnlyHermesConfig).toHaveProperty(
			"platforms.telegram.extra.group_sessions_per_user",
			true,
		);
		expect(discordOnlyHermesConfig).toHaveProperty(
			"platforms.telegram.extra.thread_sessions_per_user",
			true,
		);

		const removed = convergeRuntimeManifest(
			applyRuntimeBundleChannelsToManifestLoad({ ...load, channelBindings: [] }, paths),
			paths,
		);
		expect(removed.installErrors).toEqual([]);
		expect(readSystemdEnvFile(paths, "hermes-gateway")).not.toContain("TELEGRAM_BOT_TOKEN=");
		expect(readSystemdEnvFile(paths, "hermes-gateway")).not.toContain("DISCORD_BOT_TOKEN=");
		const clearedHermesConfig = readHermesConfigYaml(home);
		expect(clearedHermesConfig.streaming).toEqual({ enabled: false });
		expect(clearedHermesConfig.telegram.enabled).toBe(true);
		expect(clearedHermesConfig.discord).toMatchObject({
			enabled: true,
			dm_policy: "pairing",
			group_policy: "allowlist",
			allow_from: ["discord-user"],
			group_allow_from: ["discord-group-user"],
			require_mention: true,
			thread_require_mention: true,
			bots_require_inline_mention: true,
			free_response_channels: "123456789",
			auto_thread: true,
		});
		expect(clearedHermesConfig.group_sessions_per_user).toBe(false);
		expect(clearedHermesConfig.thread_sessions_per_user).toBe(true);
		expect(clearedHermesConfig).not.toHaveProperty("streaming.transport");
		expect(clearedHermesConfig).toMatchObject({
			custom_root: "keep",
			display: {
				theme: "user-theme",
				platforms: {
					discord: { streaming: false },
					telegram: { compact: true, streaming: false },
				},
			},
			platforms: {
				telegram: {
					custom: "keep-telegram",
					extra: {
						custom_extra: "keep-extra",
						group_sessions_per_user: true,
						thread_sessions_per_user: true,
					},
				},
				discord: { custom: "keep-discord" },
			},
		});
	}, 30_000);

	it("projects and removes Hermes native WhatsApp through the stock adapter config", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const hermesBin = join(home, ".local", "bin", "hermes");
		const accountId = "00000000-0000-4000-8000-000000000001";
		const accountKey = "clawdi_000000000000";
		const linkId = "60000000-0000-4000-8000-000000000006";
		const credentialId = "80000000-0000-4000-8000-000000000011";
		const agentTokenSecretRef = `secret://channels/whatsapp/${accountKey}/links/${linkId}/agent-token`;
		const capabilitySecretRef = `secret://channels/whatsapp/${accountKey}/links/${linkId}/egress-capability`;
		const credentialSecretRef = `secret://channels/whatsapp/${accountKey}/credentials/${credentialId}/creds-json`;
		const capability = `clawdi_${"0".repeat(32)}`;
		const sessionDir = join(home, ".hermes", "platforms", "whatsapp", "session");
		const baileysSocket = join(hermesManagedBaileysRoot(home), "lib", "Socket", "socket.js");
		const legacySessionDir = join(home, ".hermes", "whatsapp", "session");
		const legacySentinel = join(legacySessionDir, "unmanaged-session-sentinel");
		const systemctlPath = join(root, "bin", "systemctl");
		const systemctlLog = join(root, "whatsapp-systemctl.log");
		const systemctlStateRoot = join(root, "whatsapp-systemctl-state");
		const creds = {
			advSecretKey: "wa-hermes-secret",
			me: { id: "15551234567:1@s.whatsapp.net" },
		};
		mkdirSync(dirname(hermesBin), { recursive: true });
		mkdirSync(join(home, ".hermes"), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeHermesVersionBinary(home, "0.20.1");
		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			[
				"custom_root: keep",
				"whatsapp:",
				"  user_owned: keep-whatsapp",
				"  dm_policy: allowlist",
				'  allow_from: ["15550000001"]',
				"  group_policy: allowlist",
				'  group_allow_from: ["120363000000000000@g.us"]',
				"platforms:",
				"  matrix:",
				"    custom: keep-matrix",
				"  whatsapp:",
				"    custom: keep-platform",
				"    extra:",
				"      custom_extra: keep-extra",
				"      dm_policy: allowlist",
				'      allow_from: ["15550000001"]',
				"      group_policy: allowlist",
				'      group_allow_from: ["120363000000000000@g.us"]',
				"      group_sessions_per_user: true",
				"      thread_sessions_per_user: true",
				"",
			].join("\n"),
		);
		seedHermesManagedBaileys(home);
		writeFakeSystemdManager({
			path: systemctlPath,
			logPath: systemctlLog,
			stateRoot: systemctlStateRoot,
		});
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		process.env.CLAWDI_SYSTEMCTL_PATH = systemctlPath;
		process.env.CLAWDI_RUNTIME_USER = TEST_PROCESS_USER;
		const paths = getRuntimePaths();
		const retiredWhatsAppReceipt = join(paths.managedResourceRoot, "hermes-whatsapp.json");
		const retiredWhatsAppReceiptContent = '{"schemaVersion":"clawdi.managedHermesWhatsApp.v1"}\n';
		mkdirSync(dirname(retiredWhatsAppReceipt), { recursive: true });
		writeFileSync(retiredWhatsAppReceipt, retiredWhatsAppReceiptContent);
		mkdirSync(legacySessionDir, { recursive: true });
		writeFileSync(legacySentinel, "preserved\n");

		const channelSecrets = {
			[agentTokenSecretRef]: "wa-hermes-agent-token",
			[capabilitySecretRef]: capability,
			[credentialSecretRef]: JSON.stringify(creds),
		};
		const channelBindings: RuntimeBundleChannelBinding[] = [
			{
				provider: "whatsapp",
				accountId,
				accountKey,
				linkId,
				agentTokenSecretRef,
				placeholderTokenSecretRef: capabilitySecretRef,
				credential: {
					id: credentialId,
					credsSecretRef: credentialSecretRef,
					authCert: {
						SERIAL: 7,
						ISSUER: "clawdi",
						PUBLIC_KEY: {
							type: "Buffer",
							data: Buffer.alloc(32, 7).toString("base64"),
						},
					},
				},
			},
		];
		const load = await hostedChannelBundleLoad(home, "hermes", 14, channelBindings, channelSecrets);

		const projected = applyRuntimeBundleChannelsToManifestLoad(load, paths);
		const credentialProjection = projected.manifest.projection?.channelCredentials as unknown[];
		expect(credentialProjection).toEqual([
			expect.objectContaining({
				provider: "whatsapp",
				kind: "whatsapp_baileys_auth_state",
				accountId,
				accountKey,
				linkId,
				credentialId,
				targets: { hermes: { authDir: sessionDir } },
			}),
		]);
		expect(JSON.stringify(projected.manifest)).not.toContain("wa-hermes-secret");
		expect(JSON.stringify(projected.manifest)).not.toContain("x-clawdi-whatsapp-link-capability");
		expect(projected.secretValues?.[capabilitySecretRef]).toBeUndefined();
		expect(projected.secretValues?.[credentialSecretRef]).toContain("wa-hermes-secret");
		expect(projected.manifest.projection?.channels).toMatchObject({
			whatsapp: {
				accounts: {
					[accountKey]: {
						dmPolicy: "allowlist",
						allowFrom: ["*"],
					},
				},
			},
		});
		expect(projected.manifest.runtimes.hermes?.run?.env).toMatchObject({
			WHATSAPP_MODE: "bot",
			WHATSAPP_ALLOWED_USERS: "*",
			WHATSAPP_ALLOW_ALL_USERS: "true",
			WHATSAPP_DM_POLICY: "open",
			WHATSAPP_GROUP_POLICY: "open",
		});
		const convergence = convergeRuntimeManifest(projected, paths);
		expect(convergence.installErrors).toEqual([]);
		const egressSecrets = readFileSync(join(run, "secrets", "egress-secrets.json"), "utf-8");
		expect(egressSecrets).toContain(agentTokenSecretRef);
		expect(egressSecrets).not.toContain(capabilitySecretRef);
		expect(readFileSync(retiredWhatsAppReceipt, "utf8")).toBe(retiredWhatsAppReceiptContent);
		expect(projected.manifest.runtimes.hermes?.run?.env?.WHATSAPP_ENABLED).toBeUndefined();
		expect(readSystemdEnvFile(paths, "hermes-gateway")).not.toContain("WHATSAPP_ENABLED");
		expect(existsSync(sessionDir)).toBe(true);
		expect(readFileSync(legacySentinel, "utf-8")).toBe("preserved\n");
		expect(readHermesConfigYaml(home)).toMatchObject({
			whatsapp: {
				dm_policy: "allowlist",
				allow_from: ["15550000001"],
				group_policy: "allowlist",
				group_allow_from: ["120363000000000000@g.us"],
			},
			platforms: {
				whatsapp: {
					extra: {
						session_path: sessionDir,
						dm_policy: "allowlist",
						allow_from: ["15550000001"],
						group_policy: "allowlist",
						group_allow_from: ["120363000000000000@g.us"],
						group_sessions_per_user: true,
						thread_sessions_per_user: true,
					},
				},
			},
		});
		const initialHermesRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));
		const hermesDropIn = join(
			paths.systemdUserRoot,
			"hermes-gateway.service.d",
			"10-clawdi-hosted.conf",
		);
		const initialHermesDropInInode = statSync(hermesDropIn).ino;
		const initialUnits = readSystemdUnitSnapshot(paths);
		writeTestRuntimeAppliedState(paths, projected, convergence);
		seedFakeSystemdSnapshotProcesses(paths, systemctlStateRoot, initialUnits);
		for (const unit of initialUnits.user.keys()) {
			writeFileSync(fakeSystemdStatePath(systemctlStateRoot, "user", unit, "enabled"), "\n");
		}

		const unrelatedSecret = convergeRuntimeManifest(
			{
				...projected,
				secretValues: { ...projected.secretValues, "secret://unrelated": "changed" },
			},
			paths,
		);
		expect(unrelatedSecret.installErrors).toEqual([]);
		expect(statSync(hermesDropIn).ino).toBe(initialHermesDropInInode);
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		expect(
			applySystemdRuntimeUpdate(paths, initialUnits, readSystemdUnitSnapshot(paths), {}),
		).toMatchObject({ applied: true, systemUnitsChanged: [], userUnitsChanged: [] });
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"))).toBe(
			initialHermesRevision,
		);

		const beforeCredentialChange = readSystemdUnitSnapshot(paths);
		process.env.CLAWDI_SYSTEMD_APPLY = "0";
		const changedCheckpoint = await hostedChannelBundleLoad(home, "hermes", 14, channelBindings, {
			...channelSecrets,
			[credentialSecretRef]: JSON.stringify({
				...creds,
				advSecretKey: "wa-hermes-secret-rotated",
			}),
		});
		const changedCredential = convergeRuntimeManifest(changedCheckpoint, paths);
		expect(changedCredential.installErrors).toEqual([]);
		writeTestRuntimeAppliedState(paths, changedCheckpoint, changedCredential);
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"))).not.toBe(
			initialHermesRevision,
		);
		writeFileSync(systemctlLog, "");
		process.env.CLAWDI_SYSTEMD_APPLY = "1";
		expect(
			applySystemdRuntimeUpdate(paths, beforeCredentialChange, readSystemdUnitSnapshot(paths), {}),
		).toMatchObject({
			applied: true,
			systemUnitsChanged: [],
			userUnitsChanged: ["hermes-gateway.service"],
		});
		const systemctlCalls = readFileSync(systemctlLog, "utf-8");
		expect(systemctlCalls).toContain("--user restart hermes-gateway.service");

		const removed = await hostedChannelBundleLoad(home, "hermes", 15, [], {});
		const patchedSocket = readFileSync(baileysSocket, "utf8");
		writeFileSync(
			baileysSocket,
			patchedSocket.replace(
				"DEFAULT_CONNECTION_CONFIG.waWebSocketUrl",
				"DRIFTED_CONNECTION_CONFIG.waWebSocketUrl",
			),
		);
		const blockedRemoval = convergeRuntimeManifest(removed, paths);
		expect(blockedRemoval.installErrors.join("\n")).toContain(
			"runtime managed WhatsApp compatibility cleanup failed",
		);
		expect(readFileSync(paths.egressProfileBundle, "utf8")).toContain(
			"native-whatsapp-baileys-managed",
		);

		writeFileSync(baileysSocket, patchedSocket);
		const removedConvergence = convergeRuntimeManifest(removed, paths);
		expect(removedConvergence.installErrors).toEqual([]);
		expect(readFileSync(paths.egressProfileBundle, "utf8")).not.toContain(
			"native-whatsapp-baileys-managed",
		);
		expect(readFileSync(join(run, "secrets", "egress-secrets.json"), "utf8")).not.toContain(
			agentTokenSecretRef,
		);
		expect(existsSync(sessionDir)).toBe(false);
		writeTestRuntimeAppliedState(paths, removed, removedConvergence);
		const removedHermesConfig = readHermesConfigYaml(home);
		expect(removedHermesConfig).not.toHaveProperty("platforms.whatsapp.extra.session_path");
		expect(removedHermesConfig).toHaveProperty("whatsapp.enabled", false);
		expect(removedHermesConfig).toHaveProperty("platforms.whatsapp.enabled", false);
		expect(removedHermesConfig).toHaveProperty("whatsapp", {
			enabled: false,
			user_owned: "keep-whatsapp",
			dm_policy: "allowlist",
			allow_from: ["15550000001"],
			group_policy: "allowlist",
			group_allow_from: ["120363000000000000@g.us"],
		});
		expect(removedHermesConfig).toHaveProperty("platforms.whatsapp", {
			enabled: false,
			custom: "keep-platform",
			extra: {
				custom_extra: "keep-extra",
				dm_policy: "allowlist",
				allow_from: ["15550000001"],
				group_policy: "allowlist",
				group_allow_from: ["120363000000000000@g.us"],
				group_sessions_per_user: true,
				thread_sessions_per_user: true,
			},
		});
		expect(removedHermesConfig).toMatchObject({
			custom_root: "keep",
			platforms: { matrix: { custom: "keep-matrix" } },
		});
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_MODE).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_ENABLED).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_ALLOWED_USERS).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_ALLOW_ALL_USERS).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_DM_POLICY).toBeUndefined();
		expect(removed.manifest.runtimes.hermes?.run?.env?.WHATSAPP_GROUP_POLICY).toBeUndefined();
		expect(readSystemdEnvFile(paths, "hermes-gateway")).not.toContain("WHATSAPP_ENABLED");
		const removedHermesRevision = systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"));

		writeFileSync(
			join(home, ".hermes", "config.yaml"),
			[
				"whatsapp:",
				"  enabled: true",
				"  user_owned: manual",
				"platforms:",
				"  whatsapp:",
				"    enabled: true",
				"    extra:",
				"      session_path: /user/session",
				"",
			].join("\n"),
		);
		const driftRepair = convergeRuntimeManifest(removed, paths);
		expect(driftRepair.installErrors).toEqual([]);
		expect(readHermesConfigYaml(home)).toMatchObject({
			whatsapp: { enabled: true, user_owned: "manual" },
			platforms: { whatsapp: { enabled: true } },
		});
		expect(readHermesConfigYaml(home)).toHaveProperty(
			"platforms.whatsapp.extra.session_path",
			"/user/session",
		);
		expect(systemdEnvDigest(readSystemdEnvFile(paths, "hermes-gateway"))).toBe(
			removedHermesRevision,
		);
		const repairedConfig = readFileSync(join(home, ".hermes", "config.yaml"), "utf8");
		expect(convergeRuntimeManifest(removed, paths).installErrors).toEqual([]);
		expect(readFileSync(join(home, ".hermes", "config.yaml"), "utf8")).toBe(repairedConfig);
	}, 60_000);

	it("isolates OpenClaw WhatsApp DMs with the legacy plugin CLI", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPluginInstalls = join(root, "openclaw-whatsapp-plugin-installs.txt");
		const openclawPluginSource = join(
			home,
			".openclaw",
			"extensions",
			"whatsapp",
			"dist",
			"index.js",
		);
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
${fakeOpenClawConfigPatchCommand(join(home, ".openclaw", "openclaw.json"))}
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw 2026.7.1-2\\n'
  exit 0
fi
if [ "$*" = "plugins install @openclaw/whatsapp --force" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  mkdir -p '${dirname(openclawPluginSource)}'
  printf 'export const whatsappPlugin = true;\\n' > '${openclawPluginSource}'
  exit 0
fi
if [ "$*" = "plugins inspect whatsapp --json" ]; then
  printf '%s\\n' '${JSON.stringify(openClawWhatsAppPluginInspectFixture(openclawPluginSource))}'
  exit 0
fi
exit 0
`,
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;
		writeFakeOpenClawConfigMutationSdk(home);
		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 8);
		loaded.manifest.projection = {
			...loaded.manifest.projection,
			channels: {
				whatsapp: {
					enabled: true,
					defaultAccount: "clawdi_whatsapp",
					accounts: {
						clawdi_whatsapp: {
							enabled: true,
							authDir: join(home, ".openclaw", "credentials", "whatsapp"),
						},
					},
				},
			},
		};

		const paths = getRuntimePaths();
		const convergence = convergeRuntimeManifest(loaded, paths);
		expect(convergence.installErrors).toEqual([]);
		const configPath = join(home, ".openclaw", "openclaw.json");
		const configured = JSON.parse(readFileSync(configPath, "utf8"));
		expect(configured.channels.whatsapp.accounts.clawdi_whatsapp.authDir).toBe(
			join(home, ".openclaw", "credentials", "whatsapp"),
		);
		expect(configured.session.dmScope).toBe("per-account-channel-peer");
		expect(convergeRuntimeManifest(loaded, paths).installErrors).toEqual([]);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(configured);
		// This synthetic source has no committed bundle: omission must not authorize native deletion.
		expect(readRuntimeAppliedState(paths)).toBeNull();
		const removed = {
			...loaded,
			manifest: {
				...loaded.manifest,
				generation: 9,
				projection: { ...loaded.manifest.projection, channels: {} },
			},
		};
		expect(convergeRuntimeManifest(removed, paths).installErrors).toEqual([]);
		expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(configured);
		expect(readFileSync(openclawPluginInstalls, "utf8")).toBe(
			"plugins install @openclaw/whatsapp --force\n",
		);
	});

	it("accepts the official WhatsApp package from its ClawHub fallback", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPluginSource = join(
			home,
			".openclaw",
			"extensions",
			"whatsapp",
			"dist",
			"index.js",
		);
		const openclawPluginInstalls = join(root, "openclaw-whatsapp-plugin-installs.txt");
		const installedMarker = join(root, "whatsapp-plugin-reinstalled");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(dirname(openclawPluginSource), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(openclawPluginSource, "export const whatsappPlugin = true;\n");
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw 2026.7.1-2\\n'
  exit 0
fi
${fakeOpenClawConfigPatchCommand(join(home, ".openclaw", "openclaw.json"))}
if [ "$*" = "plugins install @openclaw/whatsapp --force" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  touch '${installedMarker}'
  exit 0
fi
if [ "$*" = "plugins inspect whatsapp --json" ]; then
  if [ -f '${installedMarker}' ]; then
    printf '%s\\n' '${JSON.stringify(openClawWhatsAppPluginInspectFixture(openclawPluginSource, "clawhub"))}'
  else
    exit 1
  fi
  exit 0
fi
exit 0
`,
		);
		chmodSync(openclawBin, 0o700);
		process.env.HOME = home;
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		process.env.CLAWDI_RUN_DIR = run;

		writeFakeOpenClawConfigMutationSdk(home);
		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 10);
		loaded.manifest.projection = {
			...loaded.manifest.projection,
			channels: {
				whatsapp: {
					enabled: true,
					defaultAccount: "clawdi_whatsapp",
					accounts: {
						clawdi_whatsapp: {
							enabled: true,
							authDir: join(home, ".openclaw", "credentials", "whatsapp"),
						},
					},
				},
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(convergeRuntimeManifest(loaded, getRuntimePaths()).installErrors).toEqual([]);
		expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe(
			"plugins install @openclaw/whatsapp --force\n",
		);
	});

	it("degrades only the OpenClaw channel whose plugin install fails", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPluginSource = join(home, ".openclaw", "extensions", "discord", "index.js");
		const discordUnavailable = join(root, "discord-plugin-unavailable");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
if [ "$*" = "plugins install --help" ]; then
  printf '%s\\n' '--accept-capabilities'
  exit 0
fi
${fakeOpenClawConfigPatchCommand(join(home, ".openclaw", "openclaw.json"))}
if [ "$*" = "plugins install @openclaw/discord --force --accept-capabilities" ]; then
  if [ -f '${discordUnavailable}' ]; then
    echo "plugin install failed" >&2
    exit 73
  fi
  mkdir -p '${dirname(openclawPluginSource)}'
  printf '%s\\n' 'export const discordPlugin = true;' > '${openclawPluginSource}'
  exit 0
fi
if [ "$*" = "plugins inspect discord --json" ]; then
  [ -f '${discordUnavailable}' ] && exit 1
  printf '%s\\n' '${JSON.stringify(openClawDiscordPluginInspectFixture(openclawPluginSource))}'
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
		const configPath = writeFakeOpenClawConfigMutationSdk(home);
		const bindings = (["telegram", "discord"] as const).map((provider) => ({
			provider,
			accountKey: `clawdi_${provider}`,
			agentTokenSecretRef: `secret://channels/${provider}/clawdi_${provider}/agent-token`,
			placeholderTokenSecretRef: `secret://channels/${provider}/clawdi_${provider}/placeholder-token`,
		}));
		const secrets = Object.fromEntries(
			bindings.flatMap((binding) => [
				[binding.agentTokenSecretRef, `${binding.provider}-agent-token`],
				[
					binding.placeholderTokenSecretRef,
					binding.provider === "telegram"
						? `999999999:${"0".repeat(32)}`
						: `clawdi_${"0".repeat(32)}`,
				],
			]),
		);
		const paths = getRuntimePaths();
		const discordOnly = bindings.filter((binding) => binding.provider === "discord");
		const discordSecrets = Object.fromEntries(
			Object.entries(secrets).filter(([ref]) => ref.includes("/discord/")),
		);
		const initial = convergeAndCommitTestRuntimeManifest(
			await hostedChannelBundleLoad(home, "openclaw", 1, discordOnly, discordSecrets),
			paths,
		);
		expect(initial.installErrors).toEqual([]);
		expect(initial.resourceProjectionErrors).toEqual([]);
		const discord = JSON.parse(readFileSync(configPath, "utf8")).channels.discord;
		expect(discord.accounts).toHaveProperty("clawdi_discord");

		// A later plugin failure must not block Telegram or withdraw the working Discord account.
		writeFileSync(discordUnavailable, "");
		const committed: number[] = [];
		const degraded = convergeRuntimeManifest(
			await hostedChannelBundleLoad(home, "openclaw", 2, bindings, secrets),
			paths,
			{ commitAuthority: (convergence) => committed.push(convergence.manifest.generation) },
		);

		expect(degraded.installErrors).toEqual([]);
		expect(degraded.resourceProjectionErrors).toEqual([
			expect.stringContaining("runtime openclaw discord channel plugin install failed"),
		]);
		expect(committed).toEqual([2]);
		const configured = JSON.parse(readFileSync(configPath, "utf8"));
		expect(configured.channels.telegram.accounts).toHaveProperty("clawdi_telegram");
		expect(configured.channels.discord).toEqual(discord);
		expect(configured.plugins.entries.discord.enabled).toBe(true);
		expect(readSystemdEnvFile(paths, "openclaw-gateway")).toContain(
			"CLAWDI_CHANNEL_TELEGRAM_CLAWDI_TELEGRAM_AGENT_TOKEN=",
		);
	});

	it("withdraws only OpenClaw managed WhatsApp while its Baileys compatibility fails", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPluginSource = join(home, ".openclaw", "extensions", "whatsapp", "index.js");
		const baileysRoot = join(dirname(openclawPluginSource), "node_modules", "baileys");
		const accountId = "00000000-0000-4000-8000-000000000001";
		const accountKey = "clawdi_000000000000";
		const linkId = "60000000-0000-4000-8000-000000000006";
		const credentialId = "80000000-0000-4000-8000-000000000011";
		const authDir = join(home, ".openclaw", "credentials", "whatsapp", accountKey);
		const whatsappAgentTokenRef = `secret://channels/whatsapp/${accountKey}/links/${linkId}/agent-token`;
		const whatsappCapabilityRef = `secret://channels/whatsapp/${accountKey}/links/${linkId}/egress-capability`;
		const whatsappCredentialRef = `secret://channels/whatsapp/${accountKey}/credentials/${credentialId}/creds-json`;
		const telegramAgentTokenRef = "secret://channels/telegram/clawdi_telegram/agent-token";
		const telegramPlaceholderRef = "secret://channels/telegram/clawdi_telegram/placeholder-token";
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
if [ "$*" = "plugins install --help" ]; then
  exit 0
fi
${fakeOpenClawConfigPatchCommand(join(home, ".openclaw", "openclaw.json"))}
if [ "$*" = "plugins install @openclaw/whatsapp --force" ]; then
  mkdir -p '${dirname(openclawPluginSource)}'
  printf '%s\\n' 'export const whatsappPlugin = true;' > '${openclawPluginSource}'
  exit 0
fi
if [ "$*" = "plugins inspect whatsapp --json" ]; then
  [ -f '${openclawPluginSource}' ] || exit 1
  printf '%s\\n' '${JSON.stringify(openClawWhatsAppPluginInspectFixture(openclawPluginSource))}'
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
		const configPath = writeFakeOpenClawConfigMutationSdk(home);
		const bindings: RuntimeBundleChannelBinding[] = [
			{
				provider: "telegram",
				accountKey: "clawdi_telegram",
				agentTokenSecretRef: telegramAgentTokenRef,
				placeholderTokenSecretRef: telegramPlaceholderRef,
			},
			{
				provider: "whatsapp",
				accountId,
				accountKey,
				linkId,
				agentTokenSecretRef: whatsappAgentTokenRef,
				placeholderTokenSecretRef: whatsappCapabilityRef,
				credential: {
					id: credentialId,
					credsSecretRef: whatsappCredentialRef,
					authCert: {
						SERIAL: 7,
						ISSUER: "clawdi",
						PUBLIC_KEY: { type: "Buffer", data: Buffer.alloc(32, 7).toString("base64") },
					},
				},
			},
		];
		const secrets = {
			[telegramAgentTokenRef]: "telegram-agent-token",
			[telegramPlaceholderRef]: `999999999:${"0".repeat(32)}`,
			[whatsappAgentTokenRef]: "whatsapp-agent-token",
			[whatsappCapabilityRef]: `clawdi_${"0".repeat(32)}`,
			[whatsappCredentialRef]: JSON.stringify({
				advSecretKey: "wa-openclaw-secret",
				me: { id: "15551234567:1@s.whatsapp.net" },
			}),
		};
		const paths = getRuntimePaths();
		const converge = async (generation: number) => {
			const load = await hostedChannelBundleLoad(home, "openclaw", generation, bindings, secrets);
			const commits: Record<string, string>[] = [];
			const convergence = convergeRuntimeManifest(load, paths, {
				commitAuthority: (_committed, authority) => {
					commits.push(authority.officialServiceCommandRevisions);
				},
			});
			expect(convergence.installErrors).toEqual([]);
			expect(commits).toHaveLength(1);
			writeTestRuntimeAppliedState(paths, load, convergence, {
				officialServiceCommandRevisions: commits[0],
			});
			return { convergence, config: JSON.parse(readFileSync(configPath, "utf8")) };
		};

		// The installed plugin has no Baileys artifact to patch.
		const withdrawn = await converge(1);
		expect(withdrawn.convergence.resourceProjectionErrors).toEqual([
			expect.stringContaining("runtime openclaw managed WhatsApp compatibility failed"),
		]);
		expect(withdrawn.config.channels.telegram.accounts).toHaveProperty("clawdi_telegram");
		expect(withdrawn.config.channels.whatsapp).toBeUndefined();
		expect(existsSync(authDir)).toBe(false);

		seedManagedBaileysArtifact(baileysRoot);
		// The OpenClaw WhatsApp plugin depends on the same artifact under its unscoped name.
		const baileysPackage = join(baileysRoot, "package.json");
		writeFileSync(
			baileysPackage,
			JSON.stringify({ ...JSON.parse(readFileSync(baileysPackage, "utf8")), name: "baileys" }),
		);
		const recovered = await converge(2);
		expect(recovered.convergence.resourceProjectionErrors).toEqual([]);
		expect(recovered.config.channels.whatsapp.accounts[accountKey].authDir).toBe(authDir);
		expect(readFileSync(join(authDir, "creds.json"), "utf8")).toContain("wa-openclaw-secret");

		// Managed auth is withdrawn rather than left on a socket that is no longer patched.
		const socket = join(baileysRoot, "lib", "Socket", "socket.js");
		writeFileSync(
			socket,
			readFileSync(socket, "utf8").replace(
				"DEFAULT_CONNECTION_CONFIG.waWebSocketUrl",
				"DRIFTED_CONNECTION_CONFIG.waWebSocketUrl",
			),
		);
		const drifted = await converge(3);
		expect(drifted.convergence.resourceProjectionErrors).toEqual([
			expect.stringContaining("runtime openclaw managed WhatsApp compatibility failed"),
		]);
		expect(drifted.config.channels.whatsapp.accounts).toEqual({});
		expect(drifted.config.channels.telegram).toEqual(recovered.config.channels.telegram);
		expect(existsSync(authDir)).toBe(false);
	});

	it("materializes, rotates, and removes OpenClaw managed WhatsApp auth", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const workspace = join(home, "clawdi");
		const accountKey = "clawdi_whatsapp_runtime";
		const accountId = "00000000-0000-0000-0000-000000000001";
		const authDir = join(home, ".openclaw", "credentials", "whatsapp", accountKey);
		mkdirSync(workspace, { recursive: true });
		mkdirSync(state, { recursive: true });
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_SERVICE_STATE_DIR = state;
		const managedMetadata = {
			schemaVersion: "clawdi.managedWhatsAppSocket.v1",
			authCert: {
				SERIAL: 7,
				ISSUER: "clawdi",
				PUBLIC_KEY: {
					type: "Buffer",
					data: Buffer.alloc(32, 7).toString("base64"),
				},
			},
		};

		const credentialSecretRef = (credentialId: string) =>
			`secret://channels/whatsapp/${accountKey}/credentials/${credentialId}/creds-json`;
		const manifestWithCredential = (
			credentialId: string,
			creds: Record<string, unknown>,
			generation: number,
		): RuntimeManifestLoad => {
			const secretRef = credentialSecretRef(credentialId);
			return {
				manifest: {
					schemaVersion: "clawdi.runtimeDesiredState.v1",
					deploymentId: "dep_whatsapp_auth_state",
					environmentId: "env_whatsapp_auth_state",
					instanceId: "iid_whatsapp_auth_state",
					generation,
					issuedAt: "2026-07-07T00:00:00Z",
					controlPlane: { apiUrl: "https://cloud-api.test" },
					runtimes: {
						openclaw: {
							enabled: true,
							install: {
								authority: "official",
								method: "official-installer",
								url: "https://openclaw.ai/install-cli.sh",
								home,
								args: [],
							},
						},
					},
					projection: {
						system: { home, workspace },
						channels: {
							whatsapp: {
								enabled: true,
								defaultAccount: accountKey,
								accounts: {
									[accountKey]: {
										enabled: true,
										authDir,
									},
								},
							},
						},
						channelCredentials: [
							{
								provider: "whatsapp",
								kind: "whatsapp_baileys_auth_state",
								accountId,
								accountKey,
								linkId: "link-whatsapp-runtime",
								credentialId,
								files: [{ path: "creds.json", secretRef }],
								targets: { openclaw: { authDir } },
							},
						],
					},
					recovery: {},
				},
				source: "remote-datasource",
				sourcePath: `test://whatsapp-auth-state-${generation}`,
				offline: false,
				secretValues: { [secretRef]: JSON.stringify(creds) },
			};
		};
		const unlinkedManifest: RuntimeManifestLoad = {
			manifest: {
				schemaVersion: "clawdi.runtimeDesiredState.v1",
				deploymentId: "dep_whatsapp_auth_state",
				environmentId: "env_whatsapp_auth_state",
				instanceId: "iid_whatsapp_auth_state",
				generation: 12,
				issuedAt: "2026-07-07T00:00:00Z",
				controlPlane: { apiUrl: "https://cloud-api.test" },
				runtimes: {
					openclaw: {
						enabled: true,
						install: {
							authority: "official",
							method: "official-installer",
							url: "https://openclaw.ai/install-cli.sh",
							home,
							args: [],
						},
					},
				},
				projection: {
					system: { home, workspace },
					channels: {},
					channelCredentials: [],
				},
				recovery: {},
			},
			source: "remote-datasource",
			sourcePath: "test://whatsapp-auth-state-unlinked",
			offline: false,
			secretValues: {},
		};

		const initialCreds = {
			advSecretKey: "wa-materialized-secret",
			me: { id: "15551234567:1@s.whatsapp.net" },
			noiseKey: { private: { type: "Buffer", data: "AQID" } },
			additionalData: {
				"clawdi.managedWhatsAppSocket": managedMetadata,
				"clawdi.managedWhatsAppCredential": {
					schemaVersion: "clawdi.managedWhatsAppCredential.v1",
					credentialId: "credential-whatsapp-1",
				},
			},
		};
		const rotatedCreds = {
			advSecretKey: "wa-rotated-secret",
			me: { id: "15557654321:1@s.whatsapp.net" },
			noiseKey: { private: { type: "Buffer", data: "BAUG" } },
			additionalData: {
				"clawdi.managedWhatsAppSocket": managedMetadata,
				"clawdi.managedWhatsAppCredential": {
					schemaVersion: "clawdi.managedWhatsAppCredential.v1",
					credentialId: "credential-whatsapp-2",
				},
			},
		};

		const initial = manifestWithCredential("credential-whatsapp-1", initialCreds, 10);
		materializeHostedChannelCredentials(initial.manifest, initial.secretValues, home);
		expect(readFileSync(join(authDir, "creds.json"), "utf8")).toContain("wa-materialized-secret");
		writeFileSync(join(authDir, "session-key.json"), '{"stale":true}\n');

		const rotated = manifestWithCredential("credential-whatsapp-2", rotatedCreds, 11);
		materializeHostedChannelCredentials(rotated.manifest, rotated.secretValues, home);
		const rotatedFile = readFileSync(join(authDir, "creds.json"), "utf8");
		expect(rotatedFile).toContain("wa-rotated-secret");
		expect(rotatedFile).not.toContain("wa-materialized-secret");
		expect(readdirSync(authDir)).toEqual(["creds.json"]);

		materializeHostedChannelCredentials(
			unlinkedManifest.manifest,
			unlinkedManifest.secretValues,
			home,
		);
		expect(existsSync(authDir)).toBe(false);
	});

	it("preserves the last good OpenClaw WhatsApp auth when the next secret is missing", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const accountKey = "clawdi_missing_whatsapp";
		const authDir = join(home, ".openclaw", "credentials", "whatsapp", accountKey);
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPatch = join(root, "openclaw-whatsapp-missing-secret-patch.jsonl");
		const openclawPluginInstalls = join(root, "openclaw-whatsapp-missing-secret-installs.txt");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		mkdirSync(authDir, { recursive: true });
		writeFileSync(
			join(authDir, "creds.json"),
			`${JSON.stringify({ advSecretKey: "stale-whatsapp-secret" })}\n`,
		);
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "patch" ] && [ "\${3:-}" = "--stdin" ]; then
  cat >> '${openclawPatch}'
  printf '\\n---\\n' >> '${openclawPatch}'
  exit 0
fi
if [ "$*" = "plugins install @openclaw/whatsapp --force --accept-capabilities" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
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

		const missingSecretRef = `secret://channels/whatsapp/${accountKey}/credentials/credential-missing/creds-json`;
		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 9);
		loaded.manifest.projection = {
			...loaded.manifest.projection,
			channels: {
				whatsapp: {
					enabled: true,
					defaultAccount: accountKey,
					accounts: { [accountKey]: { enabled: true, authDir } },
				},
			},
			channelCredentials: [
				{
					provider: "whatsapp",
					kind: "whatsapp_baileys_auth_state",
					accountKey,
					credentialId: "credential-missing",
					files: [{ path: "creds.json", secretRef: missingSecretRef }],
					targets: { openclaw: { authDir } },
				},
			],
		};

		expect(() => convergeRuntimeManifest(loaded, getRuntimePaths())).toThrow(
			`missing WhatsApp auth state secret for ${accountKey}/credential-missing`,
		);
		expect(existsSync(authDir)).toBe(true);
		expect(readFileSync(join(authDir, "creds.json"), "utf8")).toContain("stale-whatsapp-secret");
		expect(existsSync(openclawPatch)).toBe(false);
		expect(existsSync(openclawPluginInstalls)).toBe(false);
	});

	it("removes only committed managed accounts when a later projection omits them", async () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const workspace = join(home, "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPluginInstalls = join(root, "openclaw-plugin-installs.txt");
		const openclawPluginSource = join(home, ".openclaw", "extensions", "discord", "index.js");
		mkdirSync(join(home, ".local", "bin"), { recursive: true });
		mkdirSync(workspace, { recursive: true });
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
if [ "$*" = "plugins install --help" ]; then
  printf '%s\\n' '--accept-capabilities'
  exit 0
fi
${fakeOpenClawConfigPatchCommand(join(home, ".openclaw", "openclaw.json"))}
if [ "$*" = "plugins install @openclaw/discord --force --accept-capabilities" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  mkdir -p '${dirname(openclawPluginSource)}'
  printf '%s\\n' 'export const discordPlugin = true;' > '${openclawPluginSource}'
  exit 0
fi
if [ "$*" = "plugins inspect discord --json" ]; then
  printf '%s\\n' '${JSON.stringify(openClawDiscordPluginInspectFixture(openclawPluginSource))}'
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
		const personal = { enabled: true, token: "native-personal-token", dmPolicy: "pairing" };
		const configPath = writeFakeOpenClawConfigMutationSdk(home, {
			initialConfig: {
				channels: { discord: { defaultAccount: "personal", accounts: { personal } } },
			},
		});
		const bindings = (["telegram", "discord"] as const).map((provider) => ({
			provider,
			accountKey: `clawdi_${provider}`,
			agentTokenSecretRef: `secret://channels/${provider}/clawdi_${provider}/agent-token`,
			placeholderTokenSecretRef: `secret://channels/${provider}/clawdi_${provider}/placeholder-token`,
		}));
		const secrets = Object.fromEntries(
			bindings.flatMap((binding) => [
				[binding.agentTokenSecretRef, `${binding.provider}-agent-token`],
				[
					binding.placeholderTokenSecretRef,
					binding.provider === "telegram"
						? `999999999:${"0".repeat(32)}`
						: `clawdi_${"0".repeat(32)}`,
				],
			]),
		);
		const paths = getRuntimePaths();
		const initialLoad = await hostedChannelBundleLoad(home, "openclaw", 1, bindings, secrets);
		const initial = convergeAndCommitTestRuntimeManifest(initialLoad, paths);
		expect(initial.installErrors).toEqual([]);
		const configured = JSON.parse(readFileSync(configPath, "utf8"));
		expect(configured.channels.discord.accounts).toMatchObject({
			personal,
			clawdi_discord: { enabled: true },
		});
		expect(configured.channels.telegram.accounts).toHaveProperty("clawdi_telegram");
		expect(configured.session.dmScope).toBe("per-account-channel-peer");

		const telegramOnly = bindings.filter((binding) => binding.provider === "telegram");
		const telegramSecrets = Object.fromEntries(
			Object.entries(secrets).filter(([ref]) => ref.includes("/telegram/")),
		);
		const removedLoad = await hostedChannelBundleLoad(
			home,
			"openclaw",
			2,
			telegramOnly,
			telegramSecrets,
		);
		const removed = convergeAndCommitTestRuntimeManifest(removedLoad, paths);
		expect(removed.installErrors).toEqual([]);
		const remaining = JSON.parse(readFileSync(configPath, "utf8"));
		expect(remaining.channels.discord.accounts).toEqual({ personal });
		expect(remaining.channels.discord.defaultAccount).toBe("personal");
		expect(remaining.plugins.entries.discord.enabled).toBe(true);
		expect(remaining.channels.telegram).toEqual(configured.channels.telegram);
		expect(readSystemdEnvFile(paths, "openclaw-gateway")).not.toContain(
			"CLAWDI_CHANNEL_DISCORD_CLAWDI_DISCORD_AGENT_TOKEN=",
		);

		const unlinkedLoad = await hostedChannelBundleLoad(home, "openclaw", 3, [], {});
		const unlinked = convergeAndCommitTestRuntimeManifest(unlinkedLoad, paths);
		expect(unlinked.installErrors).toEqual([]);
		const final = JSON.parse(readFileSync(configPath, "utf8"));
		expect(final.channels.telegram.accounts).toEqual({});
		expect(final.channels.discord).toEqual(remaining.channels.discord);
		expect(final.session.dmScope).toBe("per-account-channel-peer");
		expect(readSystemdEnvFile(paths, "openclaw-gateway")).not.toContain(
			"CLAWDI_CHANNEL_TELEGRAM_CLAWDI_TELEGRAM_AGENT_TOKEN=",
		);
		expect(readFileSync(openclawPluginInstalls, "utf-8")).toBe(
			"plugins install @openclaw/discord --force --accept-capabilities\n",
		);
	});

	it("keeps an already-installed OpenClaw channel plugin with verified provenance", () => {
		const home = join(root, "home", "clawdi");
		const state = join(root, "var", "lib", "clawdi");
		const run = join(root, "run", "clawdi");
		const openclawBin = join(home, ".local", "bin", "openclaw");
		const openclawPluginInstalls = join(root, "openclaw-plugin-installs.txt");
		const openclawPluginSource = join(home, ".openclaw", "extensions", "discord", "index.js");
		mkdirSync(dirname(openclawBin), { recursive: true });
		mkdirSync(dirname(openclawPluginSource), { recursive: true });
		writeFileSync(openclawPluginSource, "export const discordPlugin = true;\n");
		writeFileSync(
			openclawBin,
			`#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  printf 'openclaw test-version\\n'
  exit 0
fi
if [ "$*" = "plugins install --help" ]; then
  printf '%s\\n' '--accept-capabilities'
  exit 0
fi
${fakeOpenClawConfigPatchCommand(join(home, ".openclaw", "openclaw.json"))}
if [ "$*" = "plugins install @openclaw/discord --force --accept-capabilities" ]; then
  printf '%s\\n' "$*" >> '${openclawPluginInstalls}'
  printf '%s\\n' 'export const discordPlugin = true;' > '${openclawPluginSource}'
  exit 0
fi
if [ "$*" = "plugins inspect discord --json" ]; then
  printf '%s\\n' '${JSON.stringify(openClawDiscordPluginInspectFixture(openclawPluginSource))}'
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

		writeFakeOpenClawConfigMutationSdk(home);
		const loaded = hostedSingleProviderModeLoad(home, "openclaw", "unmanaged", 2);
		loaded.manifest.projection = {
			...loaded.manifest.projection,
			channels: {
				discord: {
					enabled: true,
					accounts: { managed: { enabled: true, token: "native-discord-token" } },
				},
			},
		};

		const convergence = convergeRuntimeManifest(loaded, getRuntimePaths());

		expect(convergence.installErrors).toEqual([]);
		expect(existsSync(openclawPluginInstalls)).toBe(false);
		const native = JSON.parse(readFileSync(join(home, ".openclaw", "openclaw.json"), "utf8"));
		expect(native.channels.discord.accounts.managed).toEqual({
			enabled: true,
			token: "native-discord-token",
		});
		expect(native.plugins.entries.discord.enabled).toBe(true);
	});
});
