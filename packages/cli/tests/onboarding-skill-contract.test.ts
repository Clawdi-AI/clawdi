import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONFIG_KEYS } from "../src/lib/config";

const srcEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const skillPath = new URL("../../../apps/web/src/content/get-started.md", import.meta.url);
const webRoot = fileURLToPath(new URL("../../../apps/web/", import.meta.url));

function quickstartCommands(path: URL, heading: string): string[] {
	const section = readFileSync(path, "utf8").split(`## ${heading}\n`)[1]?.split("\n## ")[0];
	const block = section?.match(/^```bash\n([\s\S]*?)^```/m)?.[1];
	if (!block?.trim()) throw new Error(`Missing ${heading} commands in ${path.pathname}`);
	return block
		.trim()
		.split("\n")
		.map((line) => line.trim());
}

function skillCommands(markdown: string): Map<string, Set<string>> {
	const commands = new Map<string, Set<string>>();
	const blocks = [...markdown.matchAll(/^```bash\n([\s\S]*?)^```/gm)].flatMap((match) =>
		match[1].split("\n"),
	);
	const prose = markdown.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
	const inline = [...prose.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
	for (const code of [...blocks, ...inline]) {
		const command = code.match(/\bclawdi\s+([^|;&]+)/)?.[1];
		if (!command) continue;
		const tokens = command.trim().split(/\s+/);
		const path: string[] = [];
		for (const token of tokens) {
			if (!/^[a-z][a-z0-9-]*$/.test(token)) break;
			path.push(token);
		}
		const key = path.join(" ");
		const flags = commands.get(key) ?? new Set<string>();
		for (const match of command.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)(?=\s|=|$)/g)) {
			flags.add(match[1]);
		}
		commands.set(key, flags);
	}
	return commands;
}

async function help(path: string) {
	const proc = Bun.spawn(["bun", srcEntry, ...path.split(" ").filter(Boolean), "--help"], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

describe("onboarding skill CLI contract", () => {
	test("README quickstarts and dashboard steps agree and are documented in the skill", async () => {
		const rootCommands = quickstartCommands(
			new URL("../../../README.md", import.meta.url),
			"Start",
		);
		const cliCommands = quickstartCommands(new URL("../README.md", import.meta.url), "Quickstart");
		expect(rootCommands[0]).toBe("curl -fsSL https://clawdi.ai/install.sh | sh");
		// Load the exported steps in the web app's normal alias and test environment.
		const proc = Bun.spawn(
			[
				"bun",
				"--preload",
				"./test-setup.ts",
				"-e",
				'import { CLI_STEPS } from "./src/components/dashboard/add-agent-setup.tsx"; process.stdout.write(JSON.stringify(CLI_STEPS.map(({ code }) => code)));',
			],
			{ cwd: webRoot, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual(rootCommands);
		expect(cliCommands).toEqual(rootCommands);
		const skillLines = readFileSync(skillPath, "utf8")
			.split("\n")
			.map((line) => line.trim());
		for (const command of rootCommands) expect(skillLines).toContain(command);
	});

	test("extracts flags from inline commands, multiline code, and piped stdin", () => {
		const commands = skillCommands(
			"`clawdi --version`\n`clawdi\npush --all --json`\n`clawdi auth complete`\n`clawdi update --yes`\n`printf x | clawdi session extract <id> --json`\n```bash\nclawdi session extract <id> --json\n```",
		);
		expect([...commands.entries()].map(([path, flags]) => [path, [...flags]])).toEqual([
			["session extract", ["--json"]],
			["", ["--version"]],
			["push", ["--all", "--json"]],
			["auth complete", []],
			["update", ["--yes"]],
		]);
	});

	const skill = readFileSync(skillPath, "utf8");
	const commands = skillCommands(skill);
	test("documents device sign-in, non-interactive updates, and JSON sync", () => {
		expect(commands.has("auth login")).toBe(true);
		expect(commands.has("auth complete")).toBe(true);
		expect(commands.get("auth status")).toContain("--json");
		expect(commands.get("update")).toContain("--yes");
		expect(commands.get("push")).toContain("--json");
	});

	test("documents a supported project-sync opt-out", () => {
		expect(skill).toContain("To skip a project: `clawdi config set excludeProjects <path>`");
		expect(commands.has("config set")).toBe(true);
		expect(CONFIG_KEYS).toContain("excludeProjects");
	});

	for (const [path, flags] of commands) {
		test(`clawdi ${path || "(root)"}: documented commands and flags exist`, async () => {
			const result = await help(path);
			expect(result.code, result.stderr).toBe(0);
			const usage = result.stdout.split("\n").find((line) => line.startsWith("Usage: "));
			const usageTokens = usage?.split(/\s+/).slice(1) ?? [];
			const commandTokens = ["clawdi", ...path.split(" ").filter(Boolean)];
			expect(usageTokens.slice(0, commandTokens.length)).toEqual(commandTokens);
			for (const flag of flags) {
				expect(result.stdout).toMatch(new RegExp(`(?:^|\\s|,)${flag}(?=[\\s,=]|$)`, "m"));
			}
		});
	}
});
