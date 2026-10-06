import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMcpLifecycle, codexMcpLifecycle } from "./mcp-lifecycle";

const originalPath = process.env.PATH;
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;
let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "clawdi-mcp-lifecycle-"));
	mkdirSync(join(root, "bin"));
	process.env.HOME = root;
	process.env.PATH = join(root, "bin");
	delete process.env.CODEX_HOME;
});

afterEach(() => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = originalCodexHome;
	rmSync(root, { recursive: true, force: true });
});

describe("MCP lifecycle fallbacks", () => {
	test("uses ~/.local/bin/claude when Claude Code is absent from PATH", async () => {
		const launcher = join(root, ".local", "bin", "claude");
		mkdirSync(join(root, ".local", "bin"), { recursive: true });
		writeFileSync(
			launcher,
			`#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/claude-calls"
case "$*" in
  'mcp list') exit 1 ;;
  'mcp add-json '*) exit 0 ;;
esac
exit 0
`,
			{ mode: 0o755 },
		);

		expect(await claudeMcpLifecycle.register()).toBe(true);

		const calls = readFileSync(join(root, "claude-calls"), "utf8").trim().split("\n");
		expect(calls[0]).toBe("mcp list");
		expect(calls[1]).toMatch(/mcp add-json clawdi .*"command":"\/.+"/);
	});

	test("writes Codex config when its binary is unavailable and stays idempotent", async () => {
		const codexHome = join(root, "codex");
		mkdirSync(codexHome);
		process.env.CODEX_HOME = codexHome;

		expect(await codexMcpLifecycle.register()).toBe(true);
		const configPath = join(codexHome, "config.toml");
		const registered = readFileSync(configPath, "utf8");
		expect(registered).toContain("[mcp_servers.clawdi]");
		expect(await codexMcpLifecycle.register()).toBe(true);
		expect(readFileSync(configPath, "utf8")).toBe(registered);
	});
});
