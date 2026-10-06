import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code";
import { CodexAdapter } from "../../src/adapters/codex";
import { HermesAdapter } from "../../src/adapters/hermes";
import { OpenClawAdapter } from "../../src/adapters/openclaw";
import { tarSingleFile } from "../../src/lib/tar";
import {
	managedSkillReservationLedgerPath,
	reserveManagedSkill,
} from "../../src/runtime/managed-skill-reservation";
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

	test("refuses a shared write reserved at the exact target and preserves its content and ledger", async () => {
		const adapter = new Adapter();
		const target = adapter.skills.sharedPath("demo", "owner");
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, "SKILL.md"), "# Managed shared skill\n");
		reserveManagedSkill({
			targetDir: target,
			id: "demo__owner",
			version: 1,
			digest: "a".repeat(64),
			manager: "local-setup",
		});
		const ledger = readFileSync(managedSkillReservationLedgerPath(), "utf8");
		const archive = await tarSingleFile("demo", "# Replacement\n");
		await expect(adapter.skills.writeSharedArchive("demo", "owner", archive)).rejects.toThrow(
			"Skill demo__owner is reserved by a managed Skill owner",
		);
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("# Managed shared skill\n");
		expect(readFileSync(managedSkillReservationLedgerPath(), "utf8")).toBe(ledger);
	});

	test("listKeys does not migrate legacy setup skills or write a ledger", async () => {
		const legacy = join(tmpHome, ...rootParts, "clawdi");
		cpSync(join(import.meta.dir, "../fixtures/legacy-local-clawdi"), legacy, { recursive: true });
		const ledger = managedSkillReservationLedgerPath();
		expect(existsSync(ledger)).toBe(false);
		const adapter = new Adapter();
		await adapter.skills.listKeys();
		expect(existsSync(ledger)).toBe(false);
		const skills = await adapter.skills.collect();
		expect(existsSync(ledger)).toBe(true);
		expect(skills.some((skill) => skill.skillKey === "clawdi")).toBe(false);
		expect((await adapter.skills.listKeys()).sort()).toEqual(
			skills.map((skill) => skill.skillKey).sort(),
		);
	});

	test("discovers safe symlinks and skips unsafe links and hidden recovery directories", async () => {
		const root = join(tmpHome, ...rootParts);
		const recovery = join(root, ".clawdi-previous-test");
		mkdirSync(recovery, { recursive: true });
		writeFileSync(join(recovery, "SKILL.md"), "# Managed recovery artifact\n");
		for (const key of [
			".hidden",
			"dist",
			"build",
			"__pycache__",
			"reserved",
			"category/.hidden",
			"category/node_modules/bad",
			"category/nested",
			"shared/demo__owner",
		]) {
			const dir = join(root, key);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), `# ${key}\n`);
		}
		reserveManagedSkill({
			targetDir: join(root, "reserved"),
			id: "reserved",
			version: 1,
			digest: "a".repeat(64),
			manager: "local-setup",
		});
		const linked = addSkillDirectorySymlinkCases(root, join(tmpHome, "outside-skill"));
		const adapter = new Adapter();
		const skills = await adapter.skills.collect();
		expect(skills.map((skill) => skill.skillKey).sort()).toEqual(
			[
				...expectedKeys,
				...(agent === "hermes" ? ["category/nested", "shared/demo__owner"] : []),
			].sort(),
		);
		expect(skills.find((skill) => skill.skillKey === "linked")?.directoryPath).toBe(linked);
		expect((await adapter.skills.listKeys()).sort()).toEqual(
			[
				...expectedKeys,
				...(agent === "hermes" ? ["category/nested", "shared/demo__owner"] : []),
			].sort(),
		);
	});
});
