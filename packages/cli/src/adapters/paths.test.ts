import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getPiSessionsDir, matchesProjectFilter } from "./paths";

const envKeys = ["HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"] as const;
const envSnapshot = new Map(envKeys.map((key) => [key, process.env[key]]));
const originalCwd = process.cwd();
const roots: string[] = [];

afterEach(() => {
	process.chdir(originalCwd);
	for (const key of envKeys) {
		const value = envSnapshot.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function piHome(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-pi-paths-"));
	roots.push(root);
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	delete process.env.PI_CODING_AGENT_SESSION_DIR;
	mkdirSync(process.env.PI_CODING_AGENT_DIR);
	return process.env.PI_CODING_AGENT_DIR;
}

describe("Pi session directory", () => {
	test("prefers the environment override to global settings and reads changes lazily", () => {
		const home = piHome();
		writeFileSync(join(home, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
		process.env.PI_CODING_AGENT_SESSION_DIR = "/override/sessions";
		expect(getPiSessionsDir()).toBe("/override/sessions");
		delete process.env.PI_CODING_AGENT_SESSION_DIR;
		expect(getPiSessionsDir()).toBe("/global/sessions");
		writeFileSync(join(home, "settings.json"), JSON.stringify({ sessionDir: "relative-sessions" }));
		expect(getPiSessionsDir()).toBe("relative-sessions");
	});

	test("expands tilde and file URL paths from global settings and the environment", () => {
		const home = piHome();
		writeFileSync(join(home, "settings.json"), '\uFEFF{"sessionDir":"~/pi-sessions"}');
		expect(getPiSessionsDir()).toBe(join(process.env.HOME ?? "", "pi-sessions"));
		process.env.PI_CODING_AGENT_SESSION_DIR = "~";
		expect(getPiSessionsDir()).toBe(dirname(home));
		process.env.PI_CODING_AGENT_SESSION_DIR = pathToFileURL(join(home, "with spaces")).href;
		expect(getPiSessionsDir()).toBe(join(home, "with spaces"));
	});

	test.each([undefined, "{broken", "null", "[]", '{"sessionDir":42}', '{"sessionDir":""}'])(
		"uses the default for missing or invalid settings: %s",
		(content) => {
			const home = piHome();
			if (content !== undefined) writeFileSync(join(home, "settings.json"), content);
			expect(getPiSessionsDir()).toBe(join(home, "sessions"));
		},
	);

	test("does not infer project-level sessionDir from the current working directory", () => {
		const home = piHome();
		mkdirSync(join(home, ".pi"));
		writeFileSync(join(home, ".pi", "settings.json"), '{"sessionDir":"/project/sessions"}');
		process.chdir(home);
		expect(getPiSessionsDir()).toBe(join(home, "sessions"));
	});
});

test.each([
	["/repo", "/repo", true],
	["/repo/subdirectory", "/repo", true],
	["/repo2", "/repo", false],
	["/repo-other/child", "/repo", false],
	["/repo/..inside", "/repo/", true],
	["/repo/sub/../child", "/repo/", true],
	["/repo", "/", true],
	[null, "/repo", false],
	[null, null, true],
] as const)("matches project cwd %s under %s: %s", (cwd, filter, expected) => {
	expect(matchesProjectFilter(cwd, filter === null ? null : resolve(filter))).toBe(expected);
});
