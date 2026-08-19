import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { setup } from "../../src/commands/setup";
import {
	managedSkillReservationState,
	releaseManagedSkill,
} from "../../src/runtime/managed-skill-reservation";
import {
	type AgentHomeOverrideSnapshot,
	jsonResponse,
	mockFetch,
	restoreAgentHomeOverrides,
	snapshotAndClearAgentHomeOverrides,
} from "./helpers";

const tmpRoot = mkdtempSync(join(tmpdir(), "clawdi-setup-test-"));
const HERMES_CONFIG_CLI_MOCK = resolve(
	import.meta.dir,
	"../../src/test-support/hermes-config-cli-mock.ts",
);
const ENV_KEYS = [
	"CI",
	"HOME",
	"PATH",
	"CLAWDI_HOME",
	"CLAWDI_API_URL",
	"CLAWDI_AUTH_TOKEN",
	"CLAWDI_ENVIRONMENT_ID",
	"CLAWDI_STATE_DIR",
	"CLAWDI_SERVICE_STATE_DIR",
	"CLAWDI_RUNTIME_MODE",
	"CLAWDI_SERVE_MODE",
	"CLAWDI_SERVE_DEBUG",
	"HERMES_TEST_MCP_TOKEN",
] as const;

let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let agentHomeSnapshot: AgentHomeOverrideSnapshot = {};
let restoreFetch: (() => void) | null = null;
let restoreConsole: (() => void) | null = null;
let originalArgv1: string | undefined;
let home = "";
let consoleOutput: string[] = [];

afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
	home = mkdtempSync(join(tmpRoot, "case-"));
	envSnapshot = {};
	for (const key of ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) envSnapshot[key] = value;
		delete process.env[key];
	}
	agentHomeSnapshot = snapshotAndClearAgentHomeOverrides();

	process.env.CI = "1";
	process.env.HOME = home;
	process.env.CLAWDI_API_URL = "https://api.test";

	originalArgv1 = process.argv[1];
	const fakeEntry = join(home, "clawdi-bin");
	writeExecutable(fakeEntry, "#!/bin/sh\nexit 0\n");
	process.argv[1] = fakeEntry;

	const stubDir = join(home, "bin");
	mkdirSync(stubDir, { recursive: true });
	writeExecutable(join(stubDir, "codex"), "#!/bin/sh\nexit 0\n");
	writeExecutable(
		join(stubDir, "hermes"),
		`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(HERMES_CONFIG_CLI_MOCK)} "$@"\n`,
	);
	writeExecutable(
		join(stubDir, "openclaw"),
		'#!/bin/sh\nif [ "$*" = "agents list --json" ]; then printf \'[{"id":"main","workspace":"%s/.openclaw/agents/main"}]\\n\' "$HOME"; exit 0; fi\nprintf "%s\\n" "$@" > "$HOME/openclaw-mcp-args"\nexit 0\n',
	);
	writeExecutable(join(stubDir, "systemctl"), "#!/bin/sh\nexit 0\n");
	writeExecutable(join(stubDir, "launchctl"), "#!/bin/sh\nexit 0\n");
	process.env.PATH = `${stubDir}:${envSnapshot.PATH ?? ""}`;

	seedAuth();
	const originalLog = console.log;
	const originalError = console.error;
	consoleOutput = [];
	console.log = (...args: unknown[]) => {
		consoleOutput.push(args.map(String).join(" "));
	};
	console.error = (...args: unknown[]) => {
		consoleOutput.push(args.map(String).join(" "));
	};
	restoreConsole = () => {
		console.log = originalLog;
		console.error = originalError;
	};
	process.exitCode = undefined;
});

afterEach(() => {
	restoreFetch?.();
	restoreFetch = null;
	restoreConsole?.();
	restoreConsole = null;
	process.argv[1] = originalArgv1 ?? "";
	process.exitCode = undefined;

	for (const key of ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(envSnapshot)) {
		if (value !== undefined) process.env[key as (typeof ENV_KEYS)[number]] = value;
	}
	restoreAgentHomeOverrides(agentHomeSnapshot);
	rmSync(home, { recursive: true, force: true });
});

describe("setup daemon install", () => {
	it("defaults to installing one daemon unit for all registered agents", async () => {
		seedRegisteredAgent("claude_code", "env-claude");
		seedDaemonUnit("claude_code");
		const { captured } = installEnvironmentMock("env-codex");

		await setup({ agent: "codex", yes: true });

		expect(
			captured.some(
				(req) =>
					req.method === "POST" &&
					req.path === "/v1/agents" &&
					(req.body as { agent_type?: string } | undefined)?.agent_type === "codex",
			),
		).toBe(true);
		expectDaemonRunSingleton();
		expect(daemonUnitExists("claude_code")).toBe(false);
		expect(daemonUnitExists("codex")).toBe(false);
	});

	it("honors --no-daemon while still registering the requested agent", async () => {
		installEnvironmentMock("env-codex");

		await setup({ agent: "codex", yes: true, daemon: false });

		expect(existsSync(join(home, ".clawdi", "environments", "codex.json"))).toBe(true);
		expect(daemonUnitExists("daemon")).toBe(false);
		expect(daemonUnitExists("codex")).toBe(false);
	});

	it("does not install a daemon when environment registration fails", async () => {
		installFailingEnvironmentMock();

		await setup({ agent: "codex", yes: true });

		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		expect(existsSync(join(home, ".clawdi", "environments", "codex.json"))).toBe(false);
		expect(daemonUnitExists("daemon")).toBe(false);
		expect(daemonUnitExists("codex")).toBe(false);
	});

	it("installs the bundled Skill with explicit local-setup ownership", async () => {
		installEnvironmentMock("env-codex");

		await setup({ agent: "codex", yes: true, daemon: false });

		const target = join(home, ".codex", "skills", "clawdi");
		expect(existsSync(join(target, "SKILL.md"))).toBe(true);
		expect(managedSkillReservationState(target, "clawdi")).toBe("reserved");
	});

	it("reconciles the bundled Skill as an exact directory replacement", async () => {
		installEnvironmentMock("env-codex");
		await setup({ agent: "codex", yes: true, daemon: false });
		const target = join(home, ".codex", "skills", "clawdi");
		writeFileSync(join(target, "removed-by-upgrade.txt"), "stale\n");

		await setup({ agent: "codex", yes: true, daemon: false });

		expect(existsSync(join(target, "removed-by-upgrade.txt"))).toBe(false);
		expect(managedSkillReservationState(target, "clawdi")).toBe("reserved");
	});

	it("adopts a pre-ledger clawdi target under the previous exclusion contract", async () => {
		const target = join(home, ".codex", "skills", "clawdi");
		cpSync(resolve(import.meta.dir, "../../skills/clawdi"), target, { recursive: true });
		installEnvironmentMock("env-codex");

		await setup({ agent: "codex", yes: true, daemon: false });

		expect(managedSkillReservationState(target, "clawdi")).toBe("reserved");
	});

	it("refuses to replace a custom pre-ledger same-name Skill", async () => {
		const target = join(home, ".codex", "skills", "clawdi");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "# User-owned Clawdi\n");
		installEnvironmentMock("env-codex");

		await setup({ agent: "codex", yes: true, daemon: false });

		expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toBe("# User-owned Clawdi\n");
		expect(managedSkillReservationState(target, "clawdi")).toBe("unreserved");
	});

	it("does not reclaim a future user clawdi target after migration and release", async () => {
		installEnvironmentMock("env-codex");
		await setup({ agent: "codex", yes: true, daemon: false });
		const target = join(home, ".codex", "skills", "clawdi");
		releaseManagedSkill({
			targetDir: target,
			id: "clawdi",
			manager: "local-setup",
			removeTarget: () => rmSync(target, { recursive: true, force: true }),
		});
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "# Future user Clawdi\n");

		await setup({ agent: "codex", yes: true, daemon: false });

		expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toBe("# Future user Clawdi\n");
		expect(managedSkillReservationState(target, "clawdi")).toBe("unreserved");
	});

	it("sets a failing exit code without printing install success when service activation fails", async () => {
		if (process.platform !== "linux") return;
		installEnvironmentMock("env-codex");
		writeExecutable(join(home, "bin", "systemctl"), "#!/bin/sh\nexit 1\n");

		await setup({ agent: "codex", yes: true });

		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		expect(daemonUnitExists("daemon")).toBe(true);
		const output = consoleOutput.join("\n");
		expect(output).toContain("systemctl activation failed");
		expect(output).toContain("systemctl --user daemon-reload");
		expect(output).not.toContain("Singleton daemon installed");
	});
});

describe("setup Hermes MCP registration", () => {
	it("replaces cloud HTTP clawdi-mcp with canonical stdio clawdi", async () => {
		const configPath = prepareHermesConfig(
			[
				"model:",
				"  provider: custom",
				"mcp_servers:",
				"  clawdi-mcp:",
				"    url: https://backend.example.test/composio/mcp",
				"    headers:",
				"      Authorization: placeholder",
				"",
			].join("\n"),
		);
		installEnvironmentMock("env-hermes-test");

		await setup({ agent: "hermes", yes: true, daemon: false });

		const after = readFileSync(configPath, "utf-8");
		expect(parseYaml(after)).toMatchObject({
			mcp_servers: { clawdi: { command: "clawdi", args: ["mcp"] } },
		});
		expect(after).not.toContain("clawdi-mcp:");
		expect(after).not.toContain("https://backend.example.test/composio/mcp");
		expect(after).not.toContain("Authorization: placeholder");
	});

	it("normalizes a mixed clawdi block back to stdio-only", async () => {
		const configPath = prepareHermesConfig(
			[
				"mcp_servers:",
				"  clawdi:",
				'    command: "clawdi"',
				'    args: ["mcp"]',
				"    url: https://backend.example.test/composio/mcp",
				"    headers:",
				"      Authorization: placeholder",
				"  other:",
				'    command: "other"',
				"",
			].join("\n"),
		);
		installEnvironmentMock("env-hermes-test");

		await setup({ agent: "hermes", yes: true, daemon: false });

		const after = readFileSync(configPath, "utf-8");
		expect(parseYaml(after)).toMatchObject({
			mcp_servers: {
				clawdi: { command: "clawdi", args: ["mcp"] },
				other: { command: "other" },
			},
		});
		expect(after).not.toContain("https://backend.example.test/composio/mcp");
		expect(after).not.toContain("Authorization: placeholder");
	});

	it("removes duplicate HTTP sibling when stdio clawdi is already present", async () => {
		const configPath = prepareHermesConfig(
			[
				"mcp_servers:",
				"  clawdi-mcp:",
				"    url: https://backend.example.test/composio/mcp",
				"    headers:",
				"      Authorization: placeholder",
				"  clawdi:",
				'    command: "clawdi"',
				'    args: ["mcp"]',
				"  other:",
				'    command: "other"',
				"",
			].join("\n"),
		);
		installEnvironmentMock("env-hermes-test");

		await setup({ agent: "hermes", yes: true, daemon: false });

		const after = readFileSync(configPath, "utf-8");
		expect(parseYaml(after)).toMatchObject({
			mcp_servers: {
				clawdi: { command: "clawdi", args: ["mcp"] },
				other: { command: "other" },
			},
		});
		expect(after).not.toContain("clawdi-mcp:");
		expect(after).not.toContain("https://backend.example.test/composio/mcp");
	});

	it("keeps installing legacy stdio for local Hermes configs without HTTP MCP", async () => {
		const configPath = prepareHermesConfig(["model:", "  provider: custom", ""].join("\n"));
		installEnvironmentMock("env-hermes-test");

		await setup({ agent: "hermes", yes: true, daemon: false });

		const after = readFileSync(configPath, "utf-8");
		expect(parseYaml(after)).toMatchObject({
			mcp_servers: { clawdi: { command: "clawdi", args: ["mcp"] } },
		});
	});

	it("preserves env references in unrelated Hermes MCP servers", async () => {
		process.env.HERMES_TEST_MCP_TOKEN = "resolved-secret-must-not-be-written";
		const configPath = prepareHermesConfig(
			[
				"mcp_servers:",
				"  user.server:",
				"    url: https://mcp.example.test",
				"    headers:",
				'      Authorization: "Bearer ${HERMES_TEST_MCP_TOKEN}"',
				"",
			].join("\n"),
		);
		installEnvironmentMock("env-hermes-test");

		await setup({ agent: "hermes", yes: true, daemon: false });

		const after = readFileSync(configPath, "utf-8");
		expect(parseYaml(after)).toMatchObject({
			mcp_servers: {
				"user.server": {
					headers: { Authorization: "Bearer ${HERMES_TEST_MCP_TOKEN}" },
				},
				clawdi: { command: "clawdi", args: ["mcp"] },
			},
		});
		expect(after).not.toContain("resolved-secret-must-not-be-written");
	});
});

describe("setup OpenClaw MCP registration", () => {
	it("registers canonical stdio clawdi through OpenClaw MCP config", async () => {
		installEnvironmentMock("env-openclaw-test");

		await setup({ agent: "openclaw", yes: true, daemon: false });

		const args = readFileSync(join(home, "openclaw-mcp-args"), "utf-8").trim().split("\n");
		expect(args).toEqual(["mcp", "set", "clawdi", '{"command":"clawdi","args":["mcp"]}']);
	});
});

function installEnvironmentMock(envId: string) {
	const mock = mockFetch([
		{
			method: "POST",
			path: "/v1/agents",
			response: () => jsonResponse({ id: envId }),
		},
	]);
	restoreFetch = mock.restore;
	return mock;
}

function installFailingEnvironmentMock() {
	const mock = mockFetch([
		{
			method: "POST",
			path: "/v1/agents",
			response: () => jsonResponse({ error: "boom" }, 500),
		},
	]);
	restoreFetch = mock.restore;
	return mock;
}

function prepareHermesConfig(configYaml: string): string {
	const hermesHome = join(home, ".hermes");
	process.env.HERMES_HOME = hermesHome;
	const configPath = join(hermesHome, "config.yaml");
	mkdirSync(hermesHome, { recursive: true });
	writeFileSync(configPath, configYaml);
	return configPath;
}

function seedAuth(): void {
	const clawdiDir = join(home, ".clawdi");
	mkdirSync(clawdiDir, { recursive: true });
	writeFileSync(
		join(clawdiDir, "auth.json"),
		`${JSON.stringify({
			apiKey: "test-key",
			userId: "u1",
			email: "u@example.test",
			endpointBinding: { version: 1, cloudApiOrigin: "https://api.test" },
		})}\n`,
		{ mode: 0o600 },
	);
}

function seedRegisteredAgent(agent: string, envId: string): void {
	const envDir = join(home, ".clawdi", "environments");
	mkdirSync(envDir, { recursive: true });
	writeFileSync(
		join(envDir, `${agent}.json`),
		`${JSON.stringify({ id: envId, agentType: agent })}\n`,
		{ mode: 0o600 },
	);
}

function daemonUnitPath(agent: string): string {
	if (agent === "daemon") {
		if (process.platform === "darwin") {
			return join(home, "Library", "LaunchAgents", "ai.clawdi.serve.plist");
		}
		return join(home, ".config", "systemd", "user", "clawdi-serve.service");
	}
	if (process.platform === "darwin") {
		return join(home, "Library", "LaunchAgents", `ai.clawdi.serve.${agent}.plist`);
	}
	return join(home, ".config", "systemd", "user", `clawdi-serve-${agent}.service`);
}

function daemonUnitExists(agent: string): boolean {
	return existsSync(daemonUnitPath(agent));
}

function seedDaemonUnit(agent: string): void {
	const path = daemonUnitPath(agent);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "legacy daemon unit\n");
}

function readDaemonUnit(agent: string): string {
	return readFileSync(daemonUnitPath(agent), "utf-8");
}

function expectDaemonRunSingleton(): void {
	const content = readDaemonUnit("daemon");
	if (process.platform === "darwin") {
		expect(content).toContain("<string>daemon</string>");
		expect(content).toContain("<string>run</string>");
		expect(content).not.toContain("<string>--all</string>");
		expect(content).not.toContain("<string>--agent</string>");
		return;
	}
	expect(content).toContain("daemon run");
	expect(content).not.toContain("--all");
	expect(content).not.toContain("--agent");
}

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
}
