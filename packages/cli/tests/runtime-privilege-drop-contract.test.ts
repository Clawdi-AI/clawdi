import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "../src");
const PRIVILEGE_DROP_MODULE = join(SOURCE_ROOT, "runtime/runtime-user-command.ts");
const PRIVILEGE_DROP_COMMANDS = ["gosu", "runuser", "setpriv", "su"];

function sourceFiles(root: string, files: string[] = []): string[] {
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		if (statSync(path).isDirectory()) {
			sourceFiles(path, files);
		} else {
			files.push(path);
		}
	}
	return files;
}

describe("runtime privilege-drop ownership", () => {
	test("only the unified privilege module names supported command binaries", () => {
		const violations: string[] = [];
		for (const path of sourceFiles(SOURCE_ROOT)) {
			if (path === PRIVILEGE_DROP_MODULE) continue;
			const source = readFileSync(path, "utf8");
			for (const command of PRIVILEGE_DROP_COMMANDS) {
				const commandLiteral = new RegExp(`["'\\x60](?:[^"'\\x60]+/)?${command}["'\\x60]`);
				if (commandLiteral.test(source)) {
					violations.push(`${relative(SOURCE_ROOT, path)}: ${command}`);
				}
			}
		}

		expect(violations).toEqual([]);
	});

	test("the unified privilege module does not restore the removed gosu strategy", () => {
		const source = readFileSync(PRIVILEGE_DROP_MODULE, "utf8");
		const removedCommand = PRIVILEGE_DROP_COMMANDS[0];
		expect(source).not.toMatch(new RegExp(`["'\\x60]${removedCommand}["'\\x60]`));
	});
});
