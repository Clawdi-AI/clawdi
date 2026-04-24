import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..");
const binPath = join(cliRoot, "bin", "clawdi.mjs");
const srcEntry = join(cliRoot, "src", "index.ts");

/**
 * Run the CLI and return stdout + stderr + exit code.
 * Uses the src entry (fast; no build step needed). The bin wrapper smoke
 * tests verify the dist path separately (run post-build).
 */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn(["bun", srcEntry, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

describe("CLI smoke — src entry", () => {
	it("--version prints a semver-ish string", async () => {
		const { stdout, code } = await runCli(["--version"]);
		expect(code).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("--help lists every top-level command", async () => {
		const { stdout, code } = await runCli(["--help"]);
		expect(code).toBe(0);
		for (const cmd of [
			"auth",
			"status",
			"config",
			"setup",
			"push",
			"pull",
			"vault",
			"skill",
			"memory",
			"doctor",
			"update",
			"mcp",
			"run",
		]) {
			expect(stdout).toContain(cmd);
		}
	});

	it("status exits cleanly when not logged in (via isolated HOME)", async () => {
		// Point HOME at a throwaway dir so we don't read the user's real auth
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const fakeHome = join(tmpdir(), `clawdi-smoke-${Date.now()}`);
		mkdirSync(fakeHome, { recursive: true });

		try {
			const proc = Bun.spawn(["bun", srcEntry, "status"], {
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, HOME: fakeHome, CLAWDI_API_URL: "http://127.0.0.1:0" },
			});
			const stdout = await new Response(proc.stdout).text();
			const code = await proc.exited;
			expect(code).toBe(0);
			// stdout is piped (non-TTY), so status auto-renders JSON.
			const parsed = JSON.parse(stdout);
			expect(parsed.loggedIn).toBe(false);
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("unknown command exits non-zero", async () => {
		const { code } = await runCli(["nonexistent-command-xyz"]);
		expect(code).not.toBe(0);
	});

	it("config list exits 0 on an empty config", async () => {
		const { tmpdir } = await import("node:os");
		const { mkdirSync, rmSync } = await import("node:fs");
		const fakeHome = join(tmpdir(), `clawdi-smoke-cfg-${Date.now()}`);
		mkdirSync(fakeHome, { recursive: true });

		try {
			const proc = Bun.spawn(["bun", srcEntry, "config", "list"], {
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, HOME: fakeHome },
			});
			const code = await proc.exited;
			expect(code).toBe(0);
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});
});

describe("CLI smoke — bin wrapper", () => {
	it("bin/clawdi.mjs --version runs via the wrapper", async () => {
		// Only meaningful after `bun run build`; when dist/ is missing, skip gracefully.
		const { existsSync } = await import("node:fs");
		if (!existsSync(join(cliRoot, "dist", "index.js"))) return;

		const proc = Bun.spawn(["bun", binPath, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		expect(code).toBe(0);
		expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
	});
});
