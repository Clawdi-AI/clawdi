import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piMcpLifecycle } from "./mcp-lifecycle";

const originalPath = process.env.PATH;
const originalLog = console.log;
const originalError = console.error;
let root = "";
let output: string[] = [];
let errors: string[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "clawdi-pi-mcp-"));
	mkdirSync(join(root, "bin"));
	process.env.PATH = `${join(root, "bin")}:${originalPath ?? ""}`;
	output = [];
	errors = [];
	console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
	console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

afterEach(() => {
	console.log = originalLog;
	console.error = originalError;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	rmSync(root, { recursive: true, force: true });
});

function stubPi(version: string, report: unknown, listExit = 0, mutationExit = 0) {
	writeFileSync(join(root, "report.json"), JSON.stringify(report));
	writeFileSync(join(root, "version"), version);
	writeFileSync(
		join(root, "bin", "pi"),
		`#!/bin/sh
root_dir="$(dirname "$0")/.."
printf '%s\\n' "$*" >> "$root_dir/calls"
case "$*" in
  --version) cat "$root_dir/version" ;;
  'mcp list --json') cat "$root_dir/report.json"; exit ${listExit} ;;
  'mcp add clawdi -- '*|'mcp remove clawdi') exit ${mutationExit} ;;
  *) exit 99 ;;
esac
`,
		{ mode: 0o755 },
	);
}

function calls(): string[] {
	const path = join(root, "calls");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

describe("Pi MCP lifecycle", () => {
	test.each(["0.99.0", "1.0.4"])("registers through the official CLI on %s", async (version) => {
		stubPi(version, { servers: [], errors: [] });
		await piMcpLifecycle.register();
		expect(calls().slice(0, 2)).toEqual(["--version", "mcp list --json"]);
		expect(calls().at(-1)).toMatch(/^mcp add clawdi -- \/.+ mcp$/);
		expect(output.join("\n")).toContain("MCP server registered in Pi");
	});

	test("detects an existing canonical global registration from JSON", async () => {
		stubPi("1.0.4", {
			servers: [{ name: "clawdi", scope: "global", transport: "clawdi mcp", enabled: true }],
			errors: [],
		});
		await piMcpLifecycle.register();
		expect(calls()).toEqual(["--version", "mcp list --json"]);
		expect(output.join("\n")).toContain("already registered in Pi");
	});

	test.each([
		{ name: "other", scope: "global", transport: "clawdi mcp", enabled: true },
		{ name: "clawdi", scope: "project", transport: "clawdi mcp", enabled: true },
		{ name: "clawdi", scope: "global", transport: "old-command mcp", enabled: true },
		{ name: "clawdi", scope: "global", transport: "clawdi mcp", enabled: false },
	])("uses upstream add-or-replace semantics for %j", async (server) => {
		stubPi("1.0.4", { servers: [server], errors: [] });
		await piMcpLifecycle.register();
		expect(calls().at(-1)).toMatch(/^mcp add clawdi -- \/.+ mcp$/);
	});

	test("still registers when the list probe fails", async () => {
		stubPi("1.0.4", { servers: [], errors: ["fixture error"] }, 1);
		await piMcpLifecycle.register();
		expect(calls().at(-1)).toMatch(/^mcp add clawdi -- \/.+ mcp$/);
	});

	test.each(["0.98.0", "0.99.0-rc.1", "unknown"])(
		"keeps a manual hint for unsupported version %s",
		async (version) => {
			stubPi(version, { servers: [] });
			await piMcpLifecycle.register();
			await piMcpLifecycle.unregister();
			expect(calls()).toEqual(["--version", "--version"]);
			expect(output.join("\n")).toMatch(/Run manually: pi mcp add clawdi -- \/.+ mcp/);
			expect(output.join("\n")).toContain("requires Pi >= 0.99.0");
		},
	);

	test("reports a manual hint when registration fails", async () => {
		stubPi("1.0.4", { servers: [] }, 0, 1);
		await piMcpLifecycle.register();
		expect(output.join("\n")).toContain("Could not auto-register MCP server in Pi");
		expect(output.join("\n")).toMatch(/Run manually: pi mcp add clawdi -- \/.+ mcp/);
	});

	test.each(["list", "add"])(
		"returns with a manual command when the %s CLI hangs",
		async (stage) => {
			writeFileSync(
				join(root, "bin", "pi"),
				`#!/bin/sh
printf '%s\\n' "$*" >> '${root}/calls'
case "$*" in
  --version) printf '1.0.4\\n'; exit 0 ;;
  'mcp remove clawdi') exit 0 ;;
  'mcp list --json') ${stage === "list" ? "" : "printf '{\"servers\":[]}'; exit 0"} ;;
esac
exec '${process.execPath}' -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
`,
				{ mode: 0o755 },
			);

			await piMcpLifecycle.register();
			// Subsequent setup work must remain reachable after a timed-out CLI.
			await piMcpLifecycle.unregister();

			expect(errors.join("\n")).toContain("MCP registration in Pi timed out.");
			expect(errors.join("\n")).toMatch(/Run manually: pi mcp add clawdi -- \/.+ mcp/);
			expect(output.join("\n")).not.toContain("MCP server registered");
			expect(calls().at(-1)).toBe("mcp remove clawdi");
			if (stage === "list") expect(calls().some((call) => call.startsWith("mcp add"))).toBe(false);
		},
		20_000,
	);

	test.each([0, 1])("unregisters through the official CLI with exit %s", async (exit) => {
		stubPi("1.0.4", { servers: [] }, 0, exit);
		await piMcpLifecycle.unregister();
		expect(calls()).toEqual(["--version", "mcp remove clawdi"]);
		expect(output.join("\n")).toContain(
			exit === 0 ? "removed MCP server registration" : "already absent",
		);
	});
});
