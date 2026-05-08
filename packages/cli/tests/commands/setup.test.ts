import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../../src/commands/setup";
import {
	type AgentHomeOverrideSnapshot,
	jsonResponse,
	mockFetch,
	restoreAgentHomeOverrides,
	snapshotAndClearAgentHomeOverrides,
} from "./helpers";

const tmpRoot = mkdtempSync(join(tmpdir(), "clawdi-setup-test-"));
const ENV_KEYS = [
	"CI",
	"HOME",
	"PATH",
	"CLAWDI_HOME",
	"CLAWDI_API_URL",
	"CLAWDI_AUTH_TOKEN",
	"CLAWDI_ENVIRONMENT_ID",
	"CLAWDI_STATE_DIR",
	"CLAWDI_SERVE_MODE",
	"CLAWDI_SERVE_DEBUG",
] as const;

let envSnapshot: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let agentHomeSnapshot: AgentHomeOverrideSnapshot = {};
let restoreFetch: (() => void) | null = null;
let restoreConsole: (() => void) | null = null;
let originalArgv1: string | undefined;
let home = "";

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
	process.env.CLAWDI_API_URL = "http://api.test";

	originalArgv1 = process.argv[1];
	const fakeEntry = join(home, "clawdi-bin");
	writeExecutable(fakeEntry, "#!/bin/sh\nexit 0\n");
	process.argv[1] = fakeEntry;

	const stubDir = join(home, "bin");
	mkdirSync(stubDir, { recursive: true });
	writeExecutable(join(stubDir, "codex"), "#!/bin/sh\nexit 0\n");
	writeExecutable(
		join(stubDir, "openclaw"),
		'#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/openclaw-mcp-args"\nexit 0\n',
	);
	writeExecutable(join(stubDir, "systemctl"), "#!/bin/sh\nexit 0\n");
	writeExecutable(join(stubDir, "launchctl"), "#!/bin/sh\nexit 0\n");
	process.env.PATH = `${stubDir}:${envSnapshot.PATH ?? ""}`;

	seedAuth();
	const originalLog = console.log;
	const originalError = console.error;
	console.log = () => {};
	console.error = () => {};
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
	it("defaults to installing daemon units for every registered agent", async () => {
		seedRegisteredAgent("claude_code", "env-claude");
		const { captured } = installEnvironmentMock("env-codex");

		await setup({ agent: "codex", yes: true });

		expect(
			captured.some(
				(req) =>
					req.method === "POST" &&
					req.path === "/api/environments" &&
					(req.body as { agent_type?: string } | undefined)?.agent_type === "codex",
			),
		).toBe(true);
		expectDaemonRun("claude_code");
		expectDaemonRun("codex");
	});

	it("honors --no-daemon while still registering the requested agent", async () => {
		installEnvironmentMock("env-codex");

		await setup({ agent: "codex", yes: true, daemon: false });

		expect(existsSync(join(home, ".clawdi", "environments", "codex.json"))).toBe(true);
		expect(daemonUnitExists("codex")).toBe(false);
	});

	it("does not install a daemon when environment registration fails", async () => {
		installFailingEnvironmentMock();

		await setup({ agent: "codex", yes: true });

		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
		expect(existsSync(join(home, ".clawdi", "environments", "codex.json"))).toBe(false);
		expect(daemonUnitExists("codex")).toBe(false);
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
		expect(after).not.toContain("  clawdi-mcp:");
		expect(after).not.toContain("    url: https://backend.example.test/composio/mcp");
		expect(after).not.toContain("      Authorization: placeholder");
		expect(after).toContain("  clawdi:");
		expect(after).toContain('    command: "clawdi"');
		expect(after).toContain('    args: ["mcp"]');
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
		expect(after).toContain("  clawdi:");
		expect(after).toContain('    command: "clawdi"');
		expect(after).toContain('    args: ["mcp"]');
		expect(after).not.toContain("    url: https://backend.example.test/composio/mcp");
		expect(after).not.toContain("    headers:");
		expect(after).toContain("  other:");
		expect(after).toContain('    command: "other"');
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
		expect(after).not.toContain("  clawdi-mcp:");
		expect(after).not.toContain("    url: https://backend.example.test/composio/mcp");
		expect(after.match(/^ {2}clawdi:/gm)?.length).toBe(1);
		expect(after).toContain('    command: "clawdi"');
		expect(after).toContain('    args: ["mcp"]');
		expect(after).toContain("  other:");
		expect(after).toContain('    command: "other"');
	});

	it("keeps installing legacy stdio for local Hermes configs without HTTP MCP", async () => {
		const configPath = prepareHermesConfig(["model:", "  provider: custom", ""].join("\n"));
		installEnvironmentMock("env-hermes-test");

		await setup({ agent: "hermes", yes: true, daemon: false });

		const after = readFileSync(configPath, "utf-8");
		expect(after).toContain("mcp_servers:");
		expect(after).toContain("  clawdi:");
		expect(after).toContain('    command: "clawdi"');
		expect(after).toContain('    args: ["mcp"]');
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
			path: "/api/environments",
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
			path: "/api/environments",
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
		`${JSON.stringify({ apiKey: "test-key", userId: "u1", email: "u@example.test" })}\n`,
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
	if (process.platform === "darwin") {
		return join(home, "Library", "LaunchAgents", `ai.clawdi.serve.${agent}.plist`);
	}
	return join(home, ".config", "systemd", "user", `clawdi-serve-${agent}.service`);
}

function daemonUnitExists(agent: string): boolean {
	return existsSync(daemonUnitPath(agent));
}

function readDaemonUnit(agent: string): string {
	return readFileSync(daemonUnitPath(agent), "utf-8");
}

function expectDaemonRun(agent: string): void {
	const content = readDaemonUnit(agent);
	if (process.platform === "darwin") {
		expect(content).toContain("<string>daemon</string>");
		expect(content).toContain("<string>run</string>");
		expect(content).toContain(`<string>${agent}</string>`);
		return;
	}
	expect(content).toContain(`daemon run --agent ${agent}`);
}

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
}
