import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCodexMcpServer, removeCodexMcpServer } from "./codex-mcp-config";

const invocation = {
	command: "/home/test/.bun/bin/node",
	args: ["/home/test/.local/lib/clawdi/bin/clawdi.mjs", "mcp"],
	entryPath: "/home/test/.local/lib/clawdi/bin/clawdi.mjs",
};

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "clawdi-codex-mcp-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("Codex MCP config fallback", () => {
	test("appends once, preserves existing bytes, and removes its exact table", () => {
		const configPath = join(root, "config.toml");
		const original = '# keep\n[mcp_servers.other]\ncommand = "other"\n';
		writeFileSync(configPath, original, { mode: 0o640 });

		expect(ensureCodexMcpServer(configPath, invocation)).toBe(true);
		const registered = readFileSync(configPath, "utf8");
		expect(registered.startsWith(original)).toBe(true);
		expect(registered).toContain("[mcp_servers.clawdi]");
		expect(ensureCodexMcpServer(configPath, invocation)).toBe(false);
		expect(readFileSync(configPath, "utf8")).toBe(registered);
		expect(statSync(configPath).mode & 0o777).toBe(0o640);
		expect(removeCodexMcpServer(configPath, invocation)).toBe(true);
		expect(readFileSync(configPath, "utf8")).toBe(original);
	});

	test("creates a private config and skips user-owned Clawdi tables", () => {
		const codexHome = join(root, "codex");
		mkdirSync(codexHome);
		const configPath = join(codexHome, "config.toml");
		const userConfig = '[mcp_servers.clawdi]\ncommand = "user-owned"\nargs = []\n';
		writeFileSync(configPath, userConfig);

		expect(ensureCodexMcpServer(configPath, invocation)).toBe(false);
		expect(readFileSync(configPath, "utf8")).toBe(userConfig);

		const freshPath = join(codexHome, "fresh.toml");
		expect(ensureCodexMcpServer(freshPath, invocation)).toBe(true);
		expect(statSync(freshPath).mode & 0o777).toBe(0o600);
	});
});
