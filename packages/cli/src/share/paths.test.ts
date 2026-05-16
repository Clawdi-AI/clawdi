import { describe, expect, it } from "bun:test";

import { ClaudeCodeAdapter } from "../adapters/claude-code";

describe("adapter.getSharedSkillPath", () => {
	it("Claude Code: <root>/<key>__<owner-handle>", () => {
		const adapter = new ClaudeCodeAdapter();
		const p = adapter.getSharedSkillPath("git-tools", "alice-a3b4");
		expect(p).toMatch(/skills\/git-tools__alice-a3b4$/);
	});

	it("Two owners of same key produce distinct paths", () => {
		const adapter = new ClaudeCodeAdapter();
		const p1 = adapter.getSharedSkillPath("git-tools", "alice-a3b4");
		const p2 = adapter.getSharedSkillPath("git-tools", "bob-c5d6");
		expect(p1).not.toBe(p2);
	});

	it("Personal skills root stays unchanged", () => {
		const adapter = new ClaudeCodeAdapter();
		const root = adapter.getSkillsRootDir();
		expect(root).toMatch(/skills$/);
		expect(root).not.toContain("__");
	});
});
