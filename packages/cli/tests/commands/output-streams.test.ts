import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const entry = resolve(import.meta.dir, "../../src/index.ts");
let testHome = "";

beforeEach(() => {
	testHome = mkdtempSync(resolve(tmpdir(), "clawdi-output-streams-"));
});

afterEach(() => {
	rmSync(testHome, { recursive: true, force: true });
});

function runCli(args: string[]) {
	const result = spawnSync(process.execPath, [entry, ...args], {
		cwd: testHome,
		encoding: "utf8",
		timeout: 10_000,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: testHome,
			CI: "1",
			CLAWDI_RUNTIME_MODE: "local",
			CLAWDI_API_URL: "http://127.0.0.1:1",
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
		},
	});
	if (result.error) throw result.error;
	expect(result.signal).toBeNull();
	return result;
}

describe("CLI output streams", () => {
	it.each([
		["skill", "list", "--json"],
		["memory", "list", "--json"],
		["session", "search", "query", "--json"],
		["inbox", "--json"],
		["vault", "list", "--json"],
		["project", "list", "--json"],
		["push"],
		["push", "--json"],
		["pull"],
		["pull", "--json"],
		["setup"],
	])("keeps stdout empty when signed out: %j", (...args) => {
		const result = runCli(args);
		expect(result.status).toBe(4);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Not signed in. Run `clawdi auth login` first.");
	});

	it("sends the unregistered local session error to stderr", () => {
		const result = runCli(["session", "list", "--json"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("No agents are registered on this machine.");
		expect(result.stderr).toContain("Run `clawdi setup` first.");
	});

	it("sends manual login errors and their guidance to stderr", () => {
		const result = runCli(["auth", "login", "--manual"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("`clawdi auth login --manual` needs an interactive terminal.");
		expect(result.stderr).toContain("use the default device flow without --manual");
	});

	it("sends config key errors and their guidance to stderr", () => {
		const result = runCli(["config", "get", "nope"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Unknown config key: nope");
		expect(result.stderr).toContain("Known keys:");
	});

	it("exits nonzero on module validation errors and sends errors to stderr", () => {
		const result = runCli(["push", "--dry-run", "--agent", "claude_code", "--modules", "nope"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Unknown module(s): nope");
		expect(result.stderr).toContain("Valid: sessions, skills");
	});

	it("keeps unauthenticated JSON results parseable", () => {
		const result = runCli(["auth", "status", "--json"]);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ authenticated: false, source: "none" });
		expect(result.stderr).toBe("");
	});
});
