import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const skillPath = new URL("../../../apps/web/public/skill.md", import.meta.url);

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
	test("extracts flags from inline commands, multiline code, and piped stdin", () => {
		const commands = skillCommands(
			"`clawdi --version`\n`clawdi\npush --all`\n`printf '%s\\n' '<callback URL>' | clawdi auth complete`\n```bash\nclawdi session extract <id> --json\n```",
		);
		expect([...commands.entries()].map(([path, flags]) => [path, [...flags]])).toEqual([
			["session extract", ["--json"]],
			["", ["--version"]],
			["push", ["--all"]],
			["auth complete", []],
		]);
	});

	const commands = skillCommands(readFileSync(skillPath, "utf8"));
	test("finds executable examples in the skill", () => {
		expect(commands.size).toBeGreaterThan(0);
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
