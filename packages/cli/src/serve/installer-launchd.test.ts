import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { BackgroundServiceUnsupportedError, install, restart, stop, uninstall } from "./installer";

let root = "";
let restore: () => void;
const domain = `gui/${process.getuid?.()}`;
const target = `${domain}/ai.clawdi.serve`;

beforeEach(() => {
	root = mkdtempSync(join(os.tmpdir(), "clawdi-launchd-argv-"));
	const environment = { ...process.env };
	const argv1 = process.argv[1];
	const platform = spyOn(os, "platform").mockReturnValue("darwin");
	process.env.HOME = root;
	process.env.CLAWDI_HOME = join(root, ".clawdi");
	delete process.env.CLAWDI_AUTH_TOKEN;
	const bin = join(root, "bin");
	mkdirSync(bin);
	process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
	process.argv[1] = join(root, "clawdi.js");
	writeFileSync(process.argv[1], "// fixture entry\n");
	writeFileSync(
		join(bin, "launchctl"),
		`#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
case "$1" in
  print)
    [ "$2" = '${domain}' ] && [ ! -f "$HOME/no-domain" ] && exit 0
    [ "$2" = '${target}' ] && [ -f "$HOME/loaded" ] && exit 0
    exit 1 ;;
  enable) exit 0 ;;
  bootstrap) [ -f "$HOME/fail-bootstrap" ] && exit 1; touch "$HOME/loaded" ;;
  bootout) [ -f "$HOME/fail-bootout" ] && exit 1; rm -f "$HOME/loaded" ;;
  kickstart) [ -f "$HOME/fail-kickstart" ] && exit 1; exit 0 ;;
  *) exit 99 ;;
esac
`,
		{ mode: 0o755 },
	);
	restore = () => {
		platform.mockRestore();
		process.env = environment;
		process.argv[1] = argv1 ?? "";
	};
});

afterEach(() => {
	restore();
	rmSync(root, { recursive: true, force: true });
});

function calls(): string[] {
	return readFileSync(join(root, "calls"), "utf8").trim().split("\n");
}

describe("launchd modern lifecycle argv", () => {
	it("bootstraps installs, replaces loaded jobs, and keeps stop/uninstall idempotent", () => {
		const first = install();
		expect(first.replaced).toBe(false);
		expect(calls()).toEqual([
			`print ${domain}`,
			`print ${target}`,
			`enable ${target}`,
			`bootstrap ${domain} ${first.unit}`,
		]);
		expect(install().replaced).toBe(true);
		expect(calls()).toContain(`bootout ${target}`);
		restart();
		expect(calls().at(-1)).toBe(`kickstart -k ${target}`);
		stop();
		stop();
		expect(existsSync(first.unit)).toBe(true);
		restart();
		expect(calls().at(-1)).toBe(`bootstrap ${domain} ${first.unit}`);
		expect(uninstall().removed).toBe(true);
		expect(uninstall().removed).toBe(false);
		expect(calls().some((call) => /^(load|unload)\b/.test(call))).toBe(false);
	});

	it("cold-restarts after kickstart fails", () => {
		const result = install();
		writeFileSync(join(root, "fail-kickstart"), "");
		restart();
		expect(calls().slice(-3)).toEqual([
			`bootout ${target}`,
			`enable ${target}`,
			`bootstrap ${domain} ${result.unit}`,
		]);
	});

	it("preserves the plist and refuses replacement/uninstall if bootout fails", () => {
		const result = install();
		writeFileSync(join(root, "fail-bootout"), "");
		expect(() => install()).toThrow("Failed to stop running daemon");
		expect(() => uninstall()).toThrow("Failed to stop running daemon");
		expect(existsSync(result.unit)).toBe(true);
		expect(calls().filter((call) => call.startsWith("bootstrap "))).toHaveLength(1);
	});

	it("preserves the plist and reports a bootstrap activation failure", () => {
		writeFileSync(join(root, "fail-bootstrap"), "");
		expect(() => install()).toThrow(`launchctl bootstrap ${domain}`);
		expect(existsSync(join(root, "Library", "LaunchAgents", "ai.clawdi.serve.plist"))).toBe(true);
	});

	it("reports a missing GUI domain as unsupported before writing a plist", () => {
		writeFileSync(join(root, "no-domain"), "");
		expect(() => install()).toThrow(BackgroundServiceUnsupportedError);
		expect(existsSync(join(root, "Library"))).toBe(false);
	});
});
