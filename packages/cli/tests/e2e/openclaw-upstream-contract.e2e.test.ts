/**
 * Upstream OpenClaw adapter contract.
 *
 * Hosted Agents install OpenClaw with the official, unpinned installer. This
 * contract exercises Hosted integration points through the production adapter calls.
 * The shell wrapper installs OpenClaw in a disposable container before this
 * file is run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { OpenClawAdapter } from "../../src/adapters/openclaw";
import { resolveOpenClawCommandPath } from "../../src/adapters/openclaw-command";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../../src/lib/codex-oauth-native-store";
import { tarSingleFile } from "../../src/lib/tar";
import { buildOpenClawHostedProviderPatch } from "../../src/runtime/catalog-provider-config";
import {
	hostedAgentPluginTreeDigest,
	type PreparedHostedAgentPlugin,
} from "../../src/runtime/hosted-agent-plugin-package";
import {
	hostedAgentPluginCommands,
	prepareHostedAgentPluginTransaction,
} from "../../src/runtime/hosted-agent-plugin-runtime";
import {
	createOpenClawHostedContextForHome,
	installedOpenClawCommandPath,
	repairHostedOpenClawConfig,
	resolveHostedOpenClawWorkspace,
} from "../../src/runtime/hosted-openclaw-context";
import { openClawManagedChannelsPatch } from "../../src/runtime/manifest-channels";
import { HOSTED_GATEWAY_RUN_ARGS, type RuntimeManifest } from "../../src/runtime/manifest-contract";
import { runtimeCommandVersion } from "../../src/runtime/manifest-install";
import { AGENT_PLUGINS_SCHEMA_1_0_0 } from "../../src/runtime/manifest-resources";
import { runtimeServiceIsReady } from "../../src/runtime/observed";
import { readPlainOpenClawConfig } from "../../src/runtime/openclaw-config";
import {
	applyOpenClawConfigMergePatch,
	applyOpenClawGatewayHostedProjection,
	seedOpenClawMemorySearchLayout,
} from "../../src/runtime/openclaw-provider-config";
import { getRuntimePaths } from "../../src/runtime/paths";
import { OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS } from "../../src/runtime/runtime-systemd-reconciliation";
import {
	execRuntimeUserCommand,
	spawnRuntimeUserCommand,
} from "../../src/runtime/runtime-user-command";

const CONTRACT_GATE = "CLAWDI_TEST_OPENCLAW_UPSTREAM_CONTRACT";
const enabled = process.env[CONTRACT_GATE] === "1";
const home = process.env.HOME ?? "";
const command = installedOpenClawCommandPath(home) ?? "";
const configPath = join(home, ".openclaw", "openclaw.json");
const stateDir = join(home, ".openclaw");
const originalEnv = { ...process.env };
const runtimeUser = userInfo().username;
let scratch = "";
const services: ChildProcess[] = [];
const gatewayBasePath = "/clawdi-contract";
const gatewayPort = 18789;

function openclaw(args: readonly string[], timeoutMs = 120_000) {
	const result = spawnRuntimeUserCommand(command, [...args], home, home, {
		timeoutMs,
		maxBufferBytes: 16 * 1024 * 1024,
		environmentOverrides: {
			OPENCLAW_STATE_DIR: stateDir,
			OPENCLAW_CONFIG_PATH: configPath,
		},
	});
	return {
		status: result.status,
		stdout: String(result.stdout ?? ""),
		stderr: String(result.stderr ?? ""),
	};
}

function expectCommandSurface(argv: readonly string[]): void {
	const firstFlag = argv.findIndex((arg) => arg.startsWith("-"));
	const subcommand = firstFlag === -1 ? [...argv] : argv.slice(0, firstFlag);
	const flags = argv.filter((arg) => arg.startsWith("--"));
	const result = openclaw([...subcommand, "--help"]);
	expect(result.status, `openclaw ${subcommand.join(" ")} --help\n${result.stderr}`).toBe(0);
	for (const flag of flags) {
		expect(result.stdout, `openclaw ${subcommand.join(" ")} must accept ${flag}`).toContain(flag);
	}
}

function configSdk(): string {
	const sdk = resolveOpenClawSdkExport(home, [command], OPENCLAW_SDK_EXPORT_PATHS.configMutation);
	if (!sdk) throw new Error("OpenClaw config-mutation SDK is unavailable");
	return sdk;
}

function contractPlugin(): PreparedHostedAgentPlugin {
	const name = "clawdi-contract-plugin";
	const tree = [
		{
			path: "plugin.json",
			mode: 0o100644 as const,
			bytes: Buffer.from(
				JSON.stringify({ $schema: AGENT_PLUGINS_SCHEMA_1_0_0, name, version: "1.0.0" }),
			),
		},
		{
			path: "skills/plugin-probe/SKILL.md",
			mode: 0o100644 as const,
			bytes: Buffer.from(
				"---\nname: plugin-probe\ndescription: Contract plugin.\n---\n\n# Probe\n",
			),
		},
	];
	const identity = createHash("sha256").update(name).digest("hex");
	return {
		name,
		tree,
		mcpServerNames: [],
		installation: {
			installationId: "contract-plugin",
			version: "1.0.0",
			agentPluginsSchema: AGENT_PLUGINS_SCHEMA_1_0_0,
			source: {
				type: "github",
				url: "https://github.com/clawdi-ai/agent-plugins",
				path: `plugins/${name}`,
				commit: identity.slice(0, 40),
			},
			contentDigest: hostedAgentPluginTreeDigest(tree),
			ownershipIdentity: identity,
		},
	};
}

function gatewayManifest(): RuntimeManifest {
	return {
		schemaVersion: "clawdi.runtimeDesiredState.v1",
		deploymentId: "hdep_contract",
		environmentId: "contract",
		instanceId: "contract",
		generation: 1,
		issuedAt: new Date().toISOString(),
		controlPlane: { apiUrl: "https://cloud.example.test" },
		recovery: {},
		runtimes: { openclaw: { enabled: true, services: {} } },
		openclawGatewayAuth: {
			mode: "token",
			tokenRef: "secret://runtime/openclaw/gateway-token",
			deviceAuthRequired: false,
			activation: { enabled: true, capability: "openclaw-native-auth-v1" },
		},
		projection: {
			system: {
				openclawControlUiAllowedOrigins: [`http://127.0.0.1:${gatewayPort}`],
				openclawControlUiBasePath: gatewayBasePath,
			},
		},
	};
}

function startGateway(): ChildProcess {
	const child = spawn(command, [...HOSTED_GATEWAY_RUN_ARGS], {
		cwd: home,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const log = join(scratch, "gateway.log");
	child.stdout?.on("data", (chunk) => writeFileSync(log, chunk, { flag: "a" }));
	child.stderr?.on("data", (chunk) => writeFileSync(log, chunk, { flag: "a" }));
	services.push(child);
	return child;
}

function gatewayLog(): string {
	const log = join(scratch, "gateway.log");
	return existsSync(log) ? readFileSync(log, "utf8").slice(-6000) : "";
}

async function waitForGateway(child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(gatewayLog());
		if (
			await runtimeServiceIsReady("openclaw-gateway.service", getRuntimePaths({ mode: "hosted" }))
		)
			return;
		await Bun.sleep(1_000);
	}
	throw new Error(`OpenClaw gateway did not become ready\n${gatewayLog()}`);
}

async function stopGateway(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const stopped = once(child, "exit", { signal: AbortSignal.timeout(30_000) });
	child.kill("SIGTERM");
	await stopped;
}

describe.skipIf(!enabled)("upstream OpenClaw adapter contract", () => {
	let workspace = "";

	beforeAll(() => {
		if (!home || !command)
			throw new Error(`upstream OpenClaw is not installed for ${home || "the current user"}`);
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		scratch = mkdtempSync(join(tmpdir(), "clawdi-openclaw-contract-"));
		process.env.CLAWDI_SERVICE_STATE_DIR = join(scratch, "state");
		process.env.CLAWDI_RUNTIME_USER = runtimeUser;
		process.env.CLAWDI_RUNTIME_HOME = home;
		process.env.OPENCLAW_STATE_DIR = stateDir;
		process.env.OPENCLAW_CONFIG_PATH = configPath;
		process.env.CLAWDI_RUN_DIR = join(home, ".clawdi-run");
		mkdirSync(process.env.CLAWDI_RUN_DIR, { recursive: true });
		workspace = resolveHostedOpenClawWorkspace(home);
		expect(workspace).toMatch(/^\//);
		mkdirSync(join(workspace, "skills"), { recursive: true });
	});

	afterAll(async () => {
		for (const child of services) await stopGateway(child);
		process.env = { ...originalEnv };
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	});

	test("imports every SDK through the pinned system Node, including process.execPath", async () => {
		const probe = process.env.CLAWDI_OPENCLAW_NODE_SDK_PROBE;
		if (!probe) throw new Error("Node SDK probe bundle is missing");
		const result = await execRuntimeUserCommand("node", [probe], home, home, {
			timeoutMs: 180_000,
			maxBufferBytes: 4 * 1024 * 1024,
		});
		console.log(result.stdout);
		expect(result.stdout.match(/^PASS /gm)).toHaveLength(9);
	}, 200_000);

	test("reports the installed version to the runtime revision probe", () => {
		const version = runtimeCommandVersion(command, home, home);
		expect(version).toMatch(/^OpenClaw \d{4}\.\d+\.\d+ \([0-9a-f]+\)$/);
	});

	test("uses the official gateway unit and command contract", () => {
		const descriptor = OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS.find(
			(candidate) => candidate.runtime === "openclaw" && candidate.service === "gateway",
		);
		expect(descriptor).toBeDefined();
		expect(descriptor?.programName).toBe("openclaw-gateway");
		if (!descriptor) return;
		for (const argv of [
			HOSTED_GATEWAY_RUN_ARGS,
			["gateway", "restart"],
			descriptor.installArgs,
			descriptor.uninstallArgs,
		])
			expectCommandSurface(argv);
	});

	test("resolves exactly one supported memory-search schema through the production probe", () => {
		// The production probe rejects missing/ambiguous memory.search and
		// agents.defaults.memorySearch layouts; it invokes config schema without --json.
		expect(() => seedOpenClawMemorySearchLayout(command, home, configSdk())).not.toThrow();
	});

	test("applies the Hosted gateway projection through config patch --stdin", () => {
		const context = createOpenClawHostedContextForHome(home, false);
		expect(context.configMutationState.transaction).toBeNull();
		applyOpenClawGatewayHostedProjection(
			command,
			gatewayManifest(),
			{ "secret://runtime/openclaw/gateway-token": "contract-not-a-real-token" },
			context,
			workspace,
			true,
		);
		expect(readPlainOpenClawConfig(configPath)?.gateway).toMatchObject({
			mode: "local",
			port: gatewayPort,
			controlUi: { basePath: gatewayBasePath },
		});
	});

	test("resolves the official agents roster and config schema", () => {
		const roster = openclaw(["agents", "list", "--json"]);
		expect(roster.status, roster.stderr).toBe(0);
		const entries = JSON.parse(roster.stdout) as Array<Record<string, unknown>>;
		const main = entries.find((entry) => entry.id === "main");
		expect(main?.workspace).toBe(workspace);

		const schema = openclaw(["config", "schema", "--json"]);
		expect(schema.status, schema.stderr).toBe(0);
		const parsed = JSON.parse(schema.stdout) as { properties?: Record<string, unknown> };
		for (const key of ["agents", "models", "channels", "gateway"])
			expect(parsed.properties).toHaveProperty(key);

		const sessions = openclaw(["sessions", "--json", "--all-agents", "--limit", "all"]);
		expect(sessions.status, sessions.stderr).toBe(0);
		expect(JSON.parse(sessions.stdout)).toMatchObject({ sessions: expect.any(Array) });
		expect(configPath).toBe(join(home, ".openclaw", "openclaw.json"));
	});

	test("writes the provider and channel keys through the native config writer", () => {
		const sdkPath = resolveOpenClawSdkExport(
			home,
			[command],
			OPENCLAW_SDK_EXPORT_PATHS.configMutation,
		);
		expect(sdkPath).not.toBeNull();
		if (!sdkPath) return;
		const providerInput = {
			catalog: {
				schema_version: 1,
				providers: [
					{
						id: "clawdi",
						type: "custom_openai_compatible" as const,
						base_url: "https://ai.example.test/v1",
						api_mode: "openai_chat" as const,
						auth: { type: "api_key", source: "managed" as const },
						managed_by: "clawdi" as const,
						runtime_env_name: "CLAWDI_AI_API_KEY",
						models: [{ id: "contract", label: "Contract", context_window: 4096, max_tokens: 1024 }],
					},
				],
			},
			primaryModel: { provider_id: "clawdi", model: "contract" },
		} satisfies Parameters<typeof buildOpenClawHostedProviderPatch>[0];
		const providerPatch = buildOpenClawHostedProviderPatch(providerInput, []);
		const channelPatch = openClawManagedChannelsPatch({ telegram: { enabled: false } });
		applyOpenClawConfigMergePatch(sdkPath, providerPatch.content, home, home);
		applyOpenClawConfigMergePatch(sdkPath, JSON.stringify(channelPatch), home, home);
		for (const args of [
			["config", "set", "agents.defaults.workspace", workspace],
			["config", "set", "gateway.mode", "local"],
			["config", "set", "channels.telegram.enabled", "false"],
		]) {
			const result = openclaw(args);
			expect(result.status, result.stderr).toBe(0);
		}
		const config = readPlainOpenClawConfig(configPath);
		expect(config?.agents).toMatchObject({ defaults: { workspace } });
		expect(config?.models).toMatchObject({
			providers: { clawdi: { baseUrl: "https://ai.example.test/v1" } },
		});
		expect(config?.channels).toMatchObject({ telegram: { enabled: false } });
		const validation = openclaw(["config", "validate", "--json"]);
		expect(validation.status, validation.stderr).toBe(0);
		expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
	});

	test("installs, enables, inspects and removes a local Agent Plugin using production calls", () => {
		const plugin = contractPlugin();
		const commands = hostedAgentPluginCommands(home);
		const receipt = prepareHostedAgentPluginTransaction({
			prepared: {
				runtime: "openclaw",
				desired: new Map([[plugin.name, plugin]]),
				previous: new Map(),
				transientCacheOwnerships: new Set(),
			},
			home,
			commands,
		}).apply();
		const nativeId = receipt?.installations[plugin.name]?.nativeId;
		if (!nativeId) throw new Error("OpenClaw did not report the installed plugin");
		// Production install/enable use the consent-help probe and list/inspect
		// schemas, and verify the installed local bytes before recording a receipt.
		expect(receipt?.installations[plugin.name]?.contentDigest).toBe(
			plugin.installation.contentDigest,
		);
		const removal = prepareHostedAgentPluginTransaction({
			prepared: {
				runtime: "openclaw",
				desired: new Map(),
				previous: new Map([
					[
						plugin.name,
						{ runtime: "openclaw", name: plugin.name, nativeId, installation: plugin.installation },
					],
				]),
				transientCacheOwnerships: new Set(),
			},
			home,
			commands,
		});
		expect(removal.apply()).toBeNull();
	}, 300_000);

	test("repairs an invalid config through native validation and doctor", () => {
		const config = readPlainOpenClawConfig(configPath);
		if (!config) throw new Error("OpenClaw config is missing");
		writeFileSync(configPath, JSON.stringify({ ...config, clawdiContractInvalid: true }));
		try {
			// repairHostedOpenClawConfig accepts only status 1 and the exact
			// valid:false/path/issues[{path,message}] validation shape, then calls doctor.
			expect(repairHostedOpenClawConfig(home)).toBe(true);
			expect(readPlainOpenClawConfig(configPath)).not.toHaveProperty("clawdiContractInvalid");
			const validation = openclaw(["config", "validate", "--json"]);
			expect(validation.status, validation.stderr).toBe(0);
			expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
		} finally {
			writeFileSync(configPath, JSON.stringify(config));
		}
	}, 150_000);

	test("collects a session and transcript produced by OpenClaw against a local model", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname !== "/v1/chat/completions")
					return new Response("unexpected endpoint", { status: 404 });
				const body: unknown = await request.json();
				expect(body).toMatchObject({ model: "contract" });
				requests++;
				const chunk = {
					id: "chatcmpl-contract",
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "contract",
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content: "contract answer" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
				};
				return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		try {
			applyOpenClawConfigMergePatch(
				configSdk(),
				JSON.stringify({
					models: {
						providers: {
							clawdi: {
								baseUrl: `http://127.0.0.1:${server.port}/v1`,
								apiKey: "contract-not-real",
								api: "openai-completions",
								models: [
									{ id: "contract", name: "Contract", contextWindow: 32768, maxTokens: 1024 },
								],
							},
						},
					},
					agents: { defaults: { model: { primary: "clawdi/contract" }, workspace } },
				}),
				home,
				workspace,
			);
			const sessionId = "00000000-0000-4000-8000-000000000006";
			await execRuntimeUserCommand(
				command,
				[
					"agent",
					"--local",
					"--agent",
					"main",
					"--session-id",
					sessionId,
					"--message",
					"contract question",
					"--thinking",
					"off",
					"--json",
					"--timeout",
					"90",
				],
				home,
				workspace,
				{ timeoutMs: 120_000, maxBufferBytes: 4 * 1024 * 1024 },
			);
			expect(requests).toBeGreaterThan(0);
			const adapter = new OpenClawAdapter("main", stateDir);
			const result = await adapter.sessions.collect(
				{ kind: "complete" },
				{ signal: new AbortController().signal },
			);
			const session = result.sessions.find((entry) => entry.localSessionId === sessionId);
			expect(session, JSON.stringify(result.scanIssues)).toBeDefined();
			expect(session?.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: "user", content: "contract question" }),
					expect.objectContaining({ role: "assistant", content: "contract answer" }),
				]),
			);
			const inventory = openclaw(["sessions", "--json", "--all-agents", "--limit", "all"]);
			expect(inventory.status, inventory.stderr).toBe(0);
			const entries = (
				JSON.parse(inventory.stdout) as { sessions: Array<{ sessionId: string; key: string }> }
			).sessions;
			const sessionKey = entries.find((entry) => entry.sessionId === sessionId)?.key;
			if (!sessionKey) throw new Error("Native session inventory key is missing");
			const probe = process.env.CLAWDI_OPENCLAW_NODE_SDK_PROBE;
			if (!probe) throw new Error("Node SDK probe bundle is missing");
			const transcript = await execRuntimeUserCommand(
				"node",
				[probe, "transcript", sessionId, sessionKey],
				home,
				workspace,
				{ timeoutMs: 120_000, maxBufferBytes: 1024 * 1024 },
			);
			expect(transcript.stdout).toContain("PASS native session transcript through system Node");
		} finally {
			await server.stop(true);
		}
	}, 270_000);

	test("installs and discovers a Skill through the official Skills command", async () => {
		const adapter = new OpenClawAdapter("main", home);
		const archive = await tarSingleFile(
			"contract-skill",
			"---\nname: contract-skill\ndescription: Upstream contract probe.\n---\n\n# Contract\n",
		);
		await adapter.skills.writeArchive("contract-skill", archive);
		const skill = (await adapter.skills.collect()).find(
			(entry) => entry.skillKey === "contract-skill",
		);
		expect(skill?.content).toContain("Upstream contract probe");
	});

	test("uses the installer-managed command path for all gateway operations", () => {
		expect(resolveOpenClawCommandPath(home)).toBe(command);
		const wrapper = readFileSync(command, "utf8");
		expect(wrapper).toContain("/tools/node/bin/node");
	});

	test("runs the gateway, resolves included config, serves readiness/RPC/UI and restarts", async () => {
		const config = readPlainOpenClawConfig(configPath);
		if (!config?.gateway) throw new Error("Gateway config is missing");
		const includePath = join(stateDir, "contract-gateway.json");
		writeFileSync(includePath, JSON.stringify(config.gateway));
		writeFileSync(
			configPath,
			JSON.stringify({ ...config, gateway: { $include: "contract-gateway.json" } }),
		);
		let child = startGateway();
		try {
			// This production readiness path resolves the included gateway with
			// config get gateway --json and probes /readyz plus the Control UI base path.
			await waitForGateway(child);
			const readiness = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`);
			const status: unknown = await readiness.json();
			if (readiness.status === 200) expect(status).toMatchObject({ ready: true });
			else {
				expect(readiness.status).toBe(503);
				expect(status).toMatchObject({ ready: false, failing: expect.any(Array) });
			}
			const rpc = openclaw(["gateway", "status", "--json", "--timeout", "5000"]);
			expect(rpc.status, rpc.stderr).toBe(0);
			expect(JSON.parse(rpc.stdout)).toMatchObject({
				rpc: { ok: true, url: `ws://127.0.0.1:${gatewayPort}` },
			});
			const page = await fetch(`http://127.0.0.1:${gatewayPort}${gatewayBasePath}/`);
			expect(page.status).toBe(200);
			expect(await page.text()).toMatch(/<!doctype html|<html[\s>]/i);
			// Hosted systemd restart sends SIGTERM then starts the same official
			// command. Exercise that process lifecycle, retaining native config/state.
			const firstPid = child.pid;
			await stopGateway(child);
			expect(child.exitCode).toBe(0);
			child = startGateway();
			expect(child.pid).not.toBe(firstPid);
			await waitForGateway(child);
			expect((await fetch(`http://127.0.0.1:${gatewayPort}${gatewayBasePath}/`)).status).toBe(200);
		} finally {
			await stopGateway(child);
			writeFileSync(configPath, JSON.stringify(config));
			rmSync(includePath, { force: true });
		}
	}, 300_000);
});
