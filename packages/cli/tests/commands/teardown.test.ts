import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { teardown } from "../../src/commands/teardown";
import { cleanupTmp, copyFixtureToTmp } from "../adapters/helpers";
import { seedAuthAndEnv } from "./helpers";

type AgentKey = "claude-code" | "codex" | "hermes" | "openclaw";
const AGENT_TYPE: Record<AgentKey, string> = {
	"claude-code": "claude_code",
	codex: "codex",
	hermes: "hermes",
	openclaw: "openclaw",
};

let tmpHome: string;
let origHome: string | undefined;
let origExitCode: number | string | undefined;
let origIsTTY: boolean | undefined;

function setup(agent: AgentKey): {
	envPath: string;
	skillPath: string;
} {
	origHome = process.env.HOME;
	origExitCode = process.exitCode;
	tmpHome = copyFixtureToTmp(agent);
	process.env.HOME = tmpHome;
	seedAuthAndEnv(tmpHome, AGENT_TYPE[agent]);

	const envPath = join(tmpHome, ".clawdi", "environments", `${AGENT_TYPE[agent]}.json`);

	// Plant a clawdi skill where the registry expects to find it.
	let skillPath: string;
	if (agent === "openclaw") {
		const oid = process.env.OPENCLAW_AGENT_ID || "main";
		skillPath = join(tmpHome, ".openclaw", "agents", oid, "skills", "clawdi", "SKILL.md");
	} else {
		const home = `.${agent === "claude-code" ? "claude" : agent}`;
		skillPath = join(tmpHome, home, "skills", "clawdi", "SKILL.md");
	}
	mkdirSync(join(skillPath, ".."), { recursive: true });
	writeFileSync(skillPath, "---\nname: clawdi\ndescription: bundled\n---\n");

	return { envPath, skillPath };
}

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	process.exitCode = origExitCode;
	if (origIsTTY !== undefined) {
		Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
		origIsTTY = undefined;
	}
	if (tmpHome) cleanupTmp(tmpHome);
});

/**
 * Force isInteractive() → false by clearing process.stdin.isTTY for the test
 * (matches CI). teardown.ts uses that gate to refuse interactive picker.
 */
function makeNonInteractive() {
	const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	origIsTTY = desc?.value;
	Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
}

describe("teardown — basic round-trip per agent", () => {
	it("Claude Code: removes env file + bundled skill (--keep-mcp to skip claude exec)", async () => {
		const { envPath, skillPath } = setup("claude-code");
		expect(existsSync(envPath)).toBe(true);
		expect(existsSync(skillPath)).toBe(true);

		await teardown({ agent: "claude_code", yes: true, keepMcp: true });

		expect(existsSync(envPath)).toBe(false);
		expect(existsSync(skillPath)).toBe(false);
	});

	it("Codex: removes env file + bundled skill (--keep-mcp)", async () => {
		const { envPath, skillPath } = setup("codex");
		await teardown({ agent: "codex", yes: true, keepMcp: true });
		expect(existsSync(envPath)).toBe(false);
		expect(existsSync(skillPath)).toBe(false);
	});

	it("Hermes: removes env file + bundled skill (--keep-mcp)", async () => {
		const { envPath, skillPath } = setup("hermes");
		await teardown({ agent: "hermes", yes: true, keepMcp: true });
		expect(existsSync(envPath)).toBe(false);
		expect(existsSync(skillPath)).toBe(false);
	});

	it("OpenClaw: removes env file + bundled skill", async () => {
		const { envPath, skillPath } = setup("openclaw");
		// OpenClaw has no native MCP, so keepMcp is moot — should still pass cleanly.
		await teardown({ agent: "openclaw", yes: true });
		expect(existsSync(envPath)).toBe(false);
		expect(existsSync(skillPath)).toBe(false);
	});
});

describe("teardown — flag behavior", () => {
	it("--keep-skill leaves the bundled skill in place", async () => {
		const { envPath, skillPath } = setup("claude-code");
		await teardown({ agent: "claude_code", yes: true, keepMcp: true, keepSkill: true });
		expect(existsSync(envPath)).toBe(false);
		expect(existsSync(skillPath)).toBe(true);
	});

	it("--all tears down every registered agent", async () => {
		setup("hermes");
		// Plant a second registered agent — claude_code env + skill — by hand.
		seedAuthAndEnv(tmpHome, "claude_code");
		const claudeSkill = join(tmpHome, ".claude", "skills", "clawdi", "SKILL.md");
		mkdirSync(join(claudeSkill, ".."), { recursive: true });
		writeFileSync(claudeSkill, "x");

		await teardown({ all: true, yes: true, keepMcp: true });

		expect(existsSync(join(tmpHome, ".clawdi", "environments", "hermes.json"))).toBe(false);
		expect(existsSync(join(tmpHome, ".clawdi", "environments", "claude_code.json"))).toBe(false);
	});
});

describe("teardown — preflight errors set exitCode = 1", () => {
	it("--agent X but X not registered", async () => {
		setup("hermes");
		await teardown({ agent: "claude_code", yes: true });
		expect(process.exitCode).toBe(1);
	});

	it("invalid --agent value", async () => {
		setup("hermes");
		await teardown({ agent: "not_an_agent" as string, yes: true });
		expect(process.exitCode).toBe(1);
	});

	it("--agent and --all together", async () => {
		setup("hermes");
		await teardown({ agent: "hermes", all: true, yes: true });
		expect(process.exitCode).toBe(1);
	});

	it("no flags + non-TTY → refuse with exitCode 1", async () => {
		setup("hermes");
		makeNonInteractive();
		await teardown({ yes: true });
		expect(process.exitCode).toBe(1);
	});
});

describe("teardown — Hermes config.yaml MCP removal", () => {
	it("removes the clawdi block when sibling entries come BEFORE it", async () => {
		setup("hermes");
		const configPath = join(tmpHome, ".hermes", "config.yaml");
		writeFileSync(
			configPath,
			[
				"server:",
				"  port: 8080",
				"mcp_servers:",
				"  other:",
				'    command: "other"',
				"  clawdi:",
				'    command: "clawdi"',
				'    args: ["mcp"]',
				"",
			].join("\n"),
		);

		await teardown({ agent: "hermes", yes: true });

		const after = readFileSync(configPath, "utf-8");
		expect(after).not.toContain("clawdi:");
		expect(after).toContain("other:"); // didn't nuke the unrelated entry
		expect(after).toContain('command: "other"'); // and didn't eat its child line
	});

	it("removes the clawdi block when sibling entries come AFTER it (regression: sibling at same indent must NOT be absorbed)", async () => {
		setup("hermes");
		const configPath = join(tmpHome, ".hermes", "config.yaml");
		writeFileSync(
			configPath,
			[
				"mcp_servers:",
				"  clawdi:",
				'    command: "clawdi"',
				'    args: ["mcp"]',
				"  other:",
				'    command: "other"',
				'    args: ["serve"]',
				"",
			].join("\n"),
		);

		await teardown({ agent: "hermes", yes: true });

		const after = readFileSync(configPath, "utf-8");
		expect(after).not.toContain("clawdi:");
		// Critical: `other` at the same indent as `clawdi` must survive intact,
		// including its more-indented child lines.
		expect(after).toContain("  other:");
		expect(after).toContain('    command: "other"');
		expect(after).toContain('    args: ["serve"]');
	});

	it("logs gracefully when clawdi entry is absent", async () => {
		setup("hermes");
		const configPath = join(tmpHome, ".hermes", "config.yaml");
		writeFileSync(configPath, ["mcp_servers:", "  other:", '    command: "x"', ""].join("\n"));

		await teardown({ agent: "hermes", yes: true });

		const after = readFileSync(configPath, "utf-8");
		// Untouched.
		expect(after).toContain("  other:");
	});
});
