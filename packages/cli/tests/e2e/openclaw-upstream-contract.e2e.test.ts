/**
 * Upstream OpenClaw adapter contract.
 *
 * Hosted Agents install OpenClaw with the official, unpinned installer. This
 * contract exercises every production surface that depends on that install.
 * The shell wrapper installs OpenClaw in a disposable container before this
 * file is run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { OpenClawAdapter } from "../../src/adapters/openclaw";
import { resolveOpenClawCommandPath } from "../../src/adapters/openclaw-command";
import {
	OPENCLAW_SDK_EXPORT_PATHS,
	resolveOpenClawSdkExport,
} from "../../src/lib/codex-oauth-native-store";
import { tarSingleFile } from "../../src/lib/tar";
import { buildOpenClawHostedProviderPatch } from "../../src/runtime/catalog-provider-config";
import { installedOpenClawCommandPath } from "../../src/runtime/hosted-openclaw-context";
import { openClawManagedChannelsPatch } from "../../src/runtime/manifest-channels";
import { runtimeCommandVersion } from "../../src/runtime/manifest-install";
import { readPlainOpenClawConfig } from "../../src/runtime/openclaw-config";
import { applyOpenClawConfigMergePatch } from "../../src/runtime/openclaw-provider-config";
import { OFFICIAL_RUNTIME_SERVICE_DESCRIPTORS } from "../../src/runtime/runtime-systemd-reconciliation";
import { spawnRuntimeUserCommand } from "../../src/runtime/runtime-user-command";

const CONTRACT_GATE = "CLAWDI_TEST_OPENCLAW_UPSTREAM_CONTRACT";
const enabled = process.env[CONTRACT_GATE] === "1";
const home = process.env.HOME ?? "";
const command = installedOpenClawCommandPath(home) ?? "";
const configPath = join(home, ".openclaw", "openclaw.json");
const stateDir = join(home, ".openclaw");
const originalEnv = { ...process.env };
const runtimeUser = userInfo().username;

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

function writeLegacySessionFixture(workspace: string): void {
	const sessionsRoot = join(stateDir, "agents", "main", "sessions");
	mkdirSync(sessionsRoot, { recursive: true });
	const sessionId = "clawdi-upstream-contract-session";
	writeFileSync(
		join(sessionsRoot, "sessions.json"),
		`${JSON.stringify({
			[sessionId]: {
				sessionId,
				updatedAt: Date.parse("2026-10-23T00:00:02.000Z"),
				sessionFile: `${sessionId}.jsonl`,
				model: "contract-model",
				acp: { cwd: workspace },
			},
		})}\n`,
		{ mode: 0o600 },
	);
	writeFileSync(
		join(sessionsRoot, `${sessionId}.jsonl`),
		[
			JSON.stringify({
				type: "message",
				timestamp: "2026-10-23T00:00:00.000Z",
				message: { role: "user", content: "contract question" },
			}),
			JSON.stringify({
				type: "message",
				timestamp: "2026-10-23T00:00:01.000Z",
				message: { role: "assistant", content: "contract answer", model: "contract-model" },
			}),
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
}

describe.skipIf(!enabled)("upstream OpenClaw adapter contract", () => {
	let workspace = "";

	beforeAll(() => {
		if (!home || !command)
			throw new Error(`upstream OpenClaw is not installed for ${home || "the current user"}`);
		process.env.CLAWDI_RUNTIME_MODE = "hosted";
		process.env.CLAWDI_RUNTIME_USER = runtimeUser;
		process.env.CLAWDI_RUNTIME_HOME = home;
		process.env.OPENCLAW_STATE_DIR = stateDir;
		process.env.OPENCLAW_CONFIG_PATH = configPath;
		process.env.CLAWDI_RUN_DIR = join(home, ".clawdi-run");
		mkdirSync(process.env.CLAWDI_RUN_DIR, { recursive: true });
		const roster = openclaw(["agents", "list", "--json"]);
		expect(roster.status, roster.stderr).toBe(0);
		const entries = JSON.parse(roster.stdout) as Array<{ id?: string; workspace?: string }>;
		workspace = entries.find((entry) => entry.id === "main")?.workspace ?? "";
		expect(workspace).toMatch(/^\//);
		mkdirSync(join(workspace, "skills"), { recursive: true });
	});

	afterAll(() => {
		process.env = { ...originalEnv };
	});

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
			["gateway", "run"],
			["gateway", "restart"],
			descriptor.installArgs,
			descriptor.uninstallArgs,
		])
			expectCommandSurface(argv);
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
		};
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

	test("reads the OpenClaw session store and transcript format", async () => {
		writeLegacySessionFixture(workspace);
		const adapter = new OpenClawAdapter("main", stateDir, async () => null);
		const result = await adapter.sessions.collect(
			{ kind: "complete" },
			{ signal: new AbortController().signal },
		);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]).toMatchObject({
			localSessionId: "clawdi-upstream-contract-session",
			projectPath: workspace,
			messageCount: 2,
			rawFilePath: join(
				stateDir,
				"agents",
				"main",
				"sessions",
				"clawdi-upstream-contract-session.jsonl",
			),
		});
		expect(result.sessions[0]?.messages).toEqual([
			{ role: "user", content: "contract question", timestamp: "2026-10-23T00:00:00.000Z" },
			{
				role: "assistant",
				content: "contract answer",
				model: "contract-model",
				timestamp: "2026-10-23T00:00:01.000Z",
			},
		]);
	});

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
});
