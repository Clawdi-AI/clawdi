import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hermesManagedPython } from "./hermes-python";

const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
	const home = mkdtempSync(join(tmpdir(), "clawdi-hermes-python-"));
	homes.push(home);
	return home;
}

function writeExecutable(path: string, body: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return path;
}

function writePackageManagerInstall(home: string, committedPython: string | null): string {
	const storePython = join(home, ".hermes", "tools", "python", "bin", "python3");
	writeExecutable(
		storePython,
		// Upstream's read-only selection runs isolated from ambient Python configuration.
		`[ "$1" = "-I" ] || exit 64\nprintf '%s\\n' '${committedPython ?? ""}'`,
	);
	writeExecutable(
		join(home, ".local", "bin", "hermes"),
		`[ "$1" = "--print-runtime-command" ] || exit 64\nprintf '%s\\n' '["${storePython}", "-I", "-c", "pass"]'`,
	);
	return storePython;
}

test("keeps the in-tree venv of installs that predate the Hermes package manager", () => {
	const home = tempHome();
	const inTree = writeExecutable(
		join(home, ".hermes", "hermes-agent", "venv", "bin", "python"),
		"",
	);
	writePackageManagerInstall(home, "/unused");

	expect(hermesManagedPython(home)).toBe(inTree);
});

test("resolves the committed environment of a package-manager install", () => {
	const home = tempHome();
	const committed = writeExecutable(
		join(
			home,
			".hermes",
			"installs",
			"0123456789abcdef",
			"environments",
			"gen",
			"venv",
			"bin",
			"python",
		),
		"",
	);
	writePackageManagerInstall(home, committed);

	expect(hermesManagedPython(home)).toBe(committed);
});

test("fails closed when a package-manager install has no committed environment", () => {
	const home = tempHome();
	writePackageManagerInstall(home, null);

	expect(() => hermesManagedPython(home)).toThrow("Hermes has no committed Python environment");
});
