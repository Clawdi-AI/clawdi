import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentType } from "../../src/adapters/agent-types";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code";
import { teardown } from "../../src/commands/teardown";
import { managedSkillDirectoryDigest } from "../../src/runtime/hosted-bundled-skill";
import {
	managedSkillReservationState,
	migrateLegacyLocalSetupSkill,
	reserveManagedSkill,
} from "../../src/runtime/managed-skill-reservation";
import { cleanupTmp, copyFixtureToTmp } from "../adapters/helpers";
import {
	type AgentHomeOverrideSnapshot,
	restoreAgentHomeOverrides,
	seedAuthAndEnv,
	snapshotAndClearAgentHomeOverrides,
} from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origPath: string | undefined;
let origPathSet = false;
let origHomeOverrides: AgentHomeOverrideSnapshot = {};
let origIsTTY: boolean | undefined;

function setup(
	agent: AgentType,
	options: { managed?: boolean } = {},
): {
	envPath: string;
	skillPath: string;
} {
	origHome = process.env.HOME;
	origHomeOverrides = snapshotAndClearAgentHomeOverrides();
	tmpHome = copyFixtureToTmp(agent);
	process.env.HOME = tmpHome;
	process.env.HERMES_HOME = join(tmpHome, ".hermes");
	seedAuthAndEnv(tmpHome, agent);

	const envPath = join(tmpHome, ".clawdi", "environments", `${agent}.json`);

	// Plant a clawdi skill where the registry expects to find it.
	let skillPath: string;
	if (agent === "openclaw") {
		const oid = process.env.OPENCLAW_AGENT_ID || "main";
		skillPath = join(tmpHome, ".openclaw", "agents", oid, "skills", "clawdi", "SKILL.md");
	} else {
		const home = `.${agent === "claude_code" ? "claude" : agent}`;
		skillPath = join(tmpHome, home, "skills", "clawdi", "SKILL.md");
	}
	mkdirSync(join(skillPath, ".."), { recursive: true });
	writeFileSync(skillPath, "---\nname: clawdi\ndescription: bundled\n---\n");
	if (options.managed !== false) {
		reserveManagedSkill({
			targetDir: dirname(skillPath),
			id: "clawdi",
			version: 1,
			digest: "a".repeat(64),
			manager: "local-setup",
		});
		migrateLegacyLocalSetupSkill({
			targetDir: dirname(skillPath),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});
	}

	return { envPath, skillPath };
}

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origPathSet) {
		if (origPath !== undefined) process.env.PATH = origPath;
		else delete process.env.PATH;
		origPath = undefined;
		origPathSet = false;
	}
	restoreAgentHomeOverrides(origHomeOverrides);
	origHomeOverrides = {};
	process.exitCode = 0;
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

function installOpenClawStub(): string {
	if (!origPathSet) {
		origPath = process.env.PATH;
		origPathSet = true;
	}
	const stubDir = join(tmpHome, "bin");
	const argsPath = join(tmpHome, "openclaw-mcp-args");
	mkdirSync(stubDir, { recursive: true });
	const openclawPath = join(stubDir, "openclaw");
	writeFileSync(
		openclawPath,
		'#!/bin/sh\nif [ "$*" = "agents list --json" ]; then printf \'[{"id":"main","workspace":"%s/.openclaw/agents/main"}]\\n\' "$HOME"; exit 0; fi\nprintf "%s\\n" "$@" > "$HOME/openclaw-mcp-args"\nexit 0\n',
		{
			mode: 0o755,
		},
	);
	chmodSync(openclawPath, 0o755);
	process.env.PATH = `${stubDir}:${origPath ?? ""}`;
	return argsPath;
}

describe("teardown — basic round-trip per agent", () => {
	it("Claude Code: removes env file + bundled skill (--keep-mcp to skip claude exec)", async () => {
		const { envPath, skillPath } = setup("claude_code");
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

	it("OpenClaw: removes env file + bundled skill + MCP registration", async () => {
		const { envPath, skillPath } = setup("openclaw");
		const argsPath = installOpenClawStub();
		await teardown({ agent: "openclaw", yes: true });
		expect(existsSync(envPath)).toBe(false);
		expect(existsSync(skillPath)).toBe(false);
		expect(readFileSync(argsPath, "utf-8").trim().split("\n")).toEqual(["mcp", "unset", "clawdi"]);
	});
});

describe("teardown — flag behavior", () => {
	it("--keep-skill leaves the bundled skill in place", async () => {
		const { envPath, skillPath } = setup("claude_code");
		const target = dirname(skillPath);
		await teardown({ agent: "claude_code", yes: true, keepMcp: true, keepSkill: true });
		expect(existsSync(envPath)).toBe(false);
		expect(existsSync(skillPath)).toBe(true);
		expect(managedSkillReservationState(target, "clawdi")).toBe("unreserved");

		seedAuthAndEnv(tmpHome, "claude_code");
		writeFileSync(skillPath, "# User-edited retained Skill\n");
		await teardown({ agent: "claude_code", yes: true, keepMcp: true });
		expect(readFileSync(skillPath, "utf8")).toBe("# User-edited retained Skill\n");
		expect(managedSkillReservationState(target, "clawdi")).toBe("unreserved");
	});

	it("adopts and removes a genuine pre-ledger bundle on direct teardown only once", async () => {
		const { skillPath } = setup("claude_code", { managed: false });
		const target = dirname(skillPath);
		rmSync(target, { recursive: true, force: true });
		cpSync(resolve(import.meta.dir, "../../skills/clawdi"), target, { recursive: true });

		await teardown({ agent: "claude_code", yes: true, keepMcp: true });

		expect(existsSync(target)).toBe(false);
		expect(
			migrateLegacyLocalSetupSkill({
				targetDir: target,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			}),
		).toBe("already_migrated");

		seedAuthAndEnv(tmpHome, "claude_code");
		mkdirSync(target, { recursive: true });
		writeFileSync(skillPath, "---\nname: clawdi\ndescription: User Skill\n---\n");
		const adapter = new ClaudeCodeAdapter();
		expect((await adapter.collectSkills()).map((skill) => skill.skillKey)).toContain("clawdi");
		await teardown({ agent: "claude_code", yes: true, keepMcp: true });
		expect(existsSync(skillPath)).toBe(true);
		expect(managedSkillReservationState(target, "clawdi")).toBe("unreserved");
	});

	it("preserves an unproven custom same-name Skill on direct teardown", async () => {
		const { skillPath } = setup("claude_code", { managed: false });
		const target = dirname(skillPath);
		writeFileSync(skillPath, "---\nname: clawdi\ndescription: Custom Skill\n---\n");

		await teardown({ agent: "claude_code", yes: true, keepMcp: true });

		expect(existsSync(skillPath)).toBe(true);
		expect(managedSkillReservationState(target, "clawdi")).toBe("unreserved");
		expect(
			migrateLegacyLocalSetupSkill({
				targetDir: target,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			}),
		).toBe("already_migrated");
	});

	it("releases a stale reservation even when the managed target is already absent", async () => {
		const { skillPath } = setup("codex");
		const target = dirname(skillPath);
		rmSync(target, { recursive: true, force: true });
		expect(managedSkillReservationState(target, "clawdi")).toBe("reserved");

		await teardown({ agent: "codex", yes: true, keepMcp: true });

		expect(managedSkillReservationState(target, "clawdi")).toBe("unreserved");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "# Future user Skill\n");
		expect(
			migrateLegacyLocalSetupSkill({
				targetDir: target,
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			}),
		).toBe("already_migrated");
		expect(managedSkillReservationState(target, "clawdi")).toBe("unreserved");
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

	it("removes stale clawdi-mcp HTTP entries too", async () => {
		setup("hermes");
		const configPath = join(tmpHome, ".hermes", "config.yaml");
		writeFileSync(
			configPath,
			[
				"mcp_servers:",
				"  clawdi-mcp:",
				"    url: https://backend.example.test/composio/mcp",
				"    headers:",
				"      Authorization: placeholder",
				"  other:",
				'    command: "other"',
				"",
			].join("\n"),
		);

		await teardown({ agent: "hermes", yes: true });

		const after = readFileSync(configPath, "utf-8");
		expect(after).not.toContain("clawdi-mcp:");
		expect(after).not.toContain("https://backend.example.test/composio/mcp");
		expect(after).toContain("  other:");
		expect(after).toContain('    command: "other"');
	});
});
