import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code";
import { CodexAdapter } from "../../src/adapters/codex";
import { HermesAdapter } from "../../src/adapters/hermes";
import { OpenClawAdapter } from "../../src/adapters/openclaw";
import { snapshotAndClearAgentHomeOverrides } from "../commands/helpers";
import { addSkillDirectorySymlinkCases, cleanupTmp, copyFixtureToTmp } from "./helpers";

describe.each([
	["claude_code", ClaudeCodeAdapter, [".claude", "skills"], ["demo", "linked"]],
	["codex", CodexAdapter, [".codex", "skills"], ["demo", "linked"]],
	["hermes", HermesAdapter, [".hermes", "skills"], ["core/demo", "linked", "source/linked-source"]],
	["openclaw", OpenClawAdapter, [".openclaw", "agents", "main", "skills"], ["demo", "linked"]],
] as const)("%s Skill discovery contract", (agent, Adapter, rootParts, expectedKeys) => {
	let tmpHome: string;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		snapshotAndClearAgentHomeOverrides();
		delete process.env.OPENCLAW_AGENT_ID;
		tmpHome = copyFixtureToTmp(agent);
		process.env.HOME = tmpHome;
		if (agent === "openclaw") {
			const bin = join(tmpHome, "bin");
			mkdirSync(bin, { recursive: true });
			writeFileSync(
				join(bin, "openclaw"),
				`#!/bin/sh\nprintf '[{"id":"main","workspace":"%s/.openclaw/agents/main"}]\\n' "$HOME"\n`,
				{ mode: 0o700 },
			);
			process.env.PATH = `${bin}:${originalEnv.PATH ?? ""}`;
		}
	});

	afterEach(() => {
		process.env = originalEnv;
		cleanupTmp(tmpHome);
	});

	test("discovers safe symlinks and skips unsafe links and hidden recovery directories", async () => {
		const root = join(tmpHome, ...rootParts);
		const recovery = join(root, ".clawdi-previous-test");
		mkdirSync(recovery, { recursive: true });
		writeFileSync(join(recovery, "SKILL.md"), "# Managed recovery artifact\n");
		const linked = addSkillDirectorySymlinkCases(root, join(tmpHome, "outside-skill"));
		const adapter = new Adapter();
		const skills = await adapter.skills.collect();
		expect(skills.map((skill) => skill.skillKey).sort()).toEqual(expectedKeys);
		expect(skills.find((skill) => skill.skillKey === "linked")?.directoryPath).toBe(linked);
		expect((await adapter.skills.listKeys()).sort()).toEqual(expectedKeys);
	});
});
