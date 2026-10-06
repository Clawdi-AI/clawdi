import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCliVersion } from "../src/lib/version";

const srcEntry = join(import.meta.dir, "../src/index.ts");
const ansiEscape = String.fromCharCode(27);
let root = "";
let preload = "";
let bundle = "";

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "clawdi-color-output-"));
	preload = join(root, "tty.mjs");
	bundle = join(root, "cli.mjs");
	writeFileSync(
		preload,
		`for (const stream of [process.stdout, process.stderr]) {
	Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
	Object.defineProperty(stream, "columns", { value: 80, configurable: true });
}
`,
	);
	const result = await Bun.build({
		entrypoints: [srcEntry],
		target: "node",
		outdir: root,
		naming: "cli.mjs",
		define: { CLAWDI_CLI_VERSION: JSON.stringify(getCliVersion()) },
	});
	if (!result.success) throw new AggregateError(result.logs, "Could not build the CLI fixture");
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

async function runCli(
	runtime: "bun" | "node",
	args: string[],
	colorEnv: Record<string, string> = {},
): Promise<{ output: string; code: number }> {
	const invocation =
		runtime === "bun"
			? [process.execPath, "--preload", preload, srcEntry]
			: ["node", "--import", preload, bundle];
	const child = Bun.spawn([...invocation, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			HOME: root,
			CLAWDI_HOME: join(root, ".clawdi"),
			CLAWDI_API_URL: "http://127.0.0.1:0",
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
			PATH: process.env.PATH ?? "",
			TERM: "xterm-256color",
			FORCE_COLOR: "1",
			...colorEnv,
		},
	});
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { output: stdout + stderr, code };
	} finally {
		if (child.exitCode === null) {
			child.kill();
			await child.exited;
		}
	}
}

for (const runtime of ["bun", "node"] as const) {
	describe(`CLI color output (${runtime}, simulated TTY)`, () => {
		for (const command of ["status", "push"]) {
			const expectedCode = command === "status" ? 0 : 1;
			const expectedText = command === "status" ? "Clawdi Status" : "Not signed in";

			it(`${command} retains FORCE_COLOR output with an empty NO_COLOR`, async () => {
				const result = await runCli(runtime, [command], { NO_COLOR: "" });
				expect(result.code).toBe(expectedCode);
				expect(result.output).toContain(expectedText);
				expect(result.output).toContain(ansiEscape);
			});

			it(`${command} retains FORCE_COLOR=0 behavior`, async () => {
				const result = await runCli(runtime, [command], { FORCE_COLOR: "0" });
				expect(result.code).toBe(expectedCode);
				expect(result.output).toContain(expectedText);
				expect(result.output).not.toContain(ansiEscape);
			});

			for (const noColor of ["1", "0", "false", " "]) {
				it(`${command} emits no ANSI escapes with NO_COLOR=${JSON.stringify(noColor)}`, async () => {
					const result = await runCli(runtime, [command], { NO_COLOR: noColor });
					expect(result.code).toBe(expectedCode);
					expect(result.output).toContain(expectedText);
					expect(result.output).not.toContain(ansiEscape);
				});
			}

			for (const args of [
				["--no-color", command],
				[command, "--no-color"],
			]) {
				it(`${args.join(" ")} accepts the flag and emits no ANSI escapes`, async () => {
					const result = await runCli(runtime, args);
					expect(result.code).toBe(expectedCode);
					expect(result.output).toContain(expectedText);
					expect(result.output).not.toContain("unknown option");
					expect(result.output).not.toContain(ansiEscape);
				});
			}
		}

		it("accepts --no-color on a nested command", async () => {
			const result = await runCli(runtime, ["config", "list", "--no-color"]);
			expect(result.code).toBe(0);
			expect(result.output).toContain("no configuration set");
			expect(result.output).not.toContain("unknown option");
			expect(result.output).not.toContain(ansiEscape);
		});

		it("accepts --no-color on a deeply nested command", async () => {
			const result = await runCli(runtime, ["project", "folder", "list", "--no-color", "--help"]);
			expect(result.code).toBe(0);
			expect(result.output).toContain("Usage:");
			expect(result.output).not.toContain("unknown option");
			expect(result.output).not.toContain(ansiEscape);
		});

		it("keeps the auto-update notice uncolored with --no-color", async () => {
			mkdirSync(join(root, ".clawdi"), { recursive: true });
			writeFileSync(join(root, ".clawdi", "last-version"), "0.1.0\n");
			const result = await runCli(runtime, ["status", "--no-color"]);
			expect(result.code).toBe(0);
			expect(result.output).toContain("Updated clawdi to v");
			expect(result.output).toContain("Clawdi Status");
			expect(result.output).not.toContain(ansiEscape);
		});

		it("ignores a forwarded --no-color after the argument separator", async () => {
			const result = await runCli(runtime, ["run", "--", "echo", "--no-color"]);
			expect(result.code).toBe(1);
			expect(result.output).toContain("Not signed in");
			expect(result.output).toContain(ansiEscape);
		});
	});
}
