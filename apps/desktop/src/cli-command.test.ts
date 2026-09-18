import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hasManagedAppImageCliCommand, installDesktopCliCommand } from "./cli-command";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Desktop CLI command", () => {
	test.skipIf(process.platform === "win32")(
		"installs one Linux launcher without copying the bundled CLI",
		async () => {
			const fixture = createFixture();
			const launcher = join(fixture.home, ".local", "bin", "clawdi");
			const result = await installDesktopCliCommand({
				platform: "linux",
				target: fixture.target,
				home: fixture.home,
				userData: fixture.userData,
				environmentPath: dirname(launcher),
			});

			expect(result).toEqual({ status: "installed", path: launcher, pathReady: true });
			expect(lstatSync(launcher).isSymbolicLink()).toBe(true);
			expect(resolve(dirname(launcher), readlinkSync(launcher))).toBe(fixture.target);
		},
	);

	test.skipIf(process.platform === "win32")(
		"does not replace an existing command owned by another installation",
		async () => {
			const fixture = createFixture();
			const existingBin = join(fixture.root, "existing-bin");
			const existing = join(existingBin, "clawdi");
			mkdirSync(existingBin);
			writeFileSync(existing, "#!/bin/sh\n", { mode: 0o755 });

			const result = await installDesktopCliCommand({
				platform: "linux",
				target: fixture.target,
				home: fixture.home,
				userData: fixture.userData,
				environmentPath: existingBin,
			});

			expect(result).toEqual({ status: "existing-command", path: existing });
			expect(lstatSync(existing).isFile()).toBe(true);
		},
	);

	test("does not replace a foreign launcher outside PATH", async () => {
		const fixture = createFixture();
		const launcher = join(fixture.home, ".local", "bin", "clawdi");
		mkdirSync(dirname(launcher), { recursive: true });
		writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o755 });

		expect(
			installDesktopCliCommand({
				platform: "linux",
				target: fixture.target,
				home: fixture.home,
				userData: fixture.userData,
				environmentPath: "",
			}),
		).rejects.toThrow(`A different command already exists at ${launcher}.`);
	});

	test("refreshes only an application-owned AppImage launcher", async () => {
		const fixture = createFixture();
		const oldTarget = join(fixture.userData, "runtimes", "1.0.0", "clawdi");
		const nextTarget = join(fixture.userData, "runtimes", "1.0.1", "clawdi");
		const launcher = join(fixture.home, ".local", "bin", "clawdi");
		for (const target of [oldTarget, nextTarget]) {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, "binary", { mode: 0o755 });
		}
		mkdirSync(dirname(launcher), { recursive: true });
		symlinkSync(oldTarget, launcher);
		expect(hasManagedAppImageCliCommand({ home: fixture.home, userData: fixture.userData })).toBe(
			true,
		);

		await installDesktopCliCommand({
			platform: "linux",
			target: nextTarget,
			home: fixture.home,
			userData: fixture.userData,
			environmentPath: "",
		});

		expect(resolve(dirname(launcher), readlinkSync(launcher))).toBe(nextTarget);
	});

	test("writes a Windows launcher and adds only its directory to user PATH", async () => {
		const fixture = createFixture();
		const launcher = join(fixture.root, "windows-bin", "clawdi.cmd");
		const calls: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];

		const result = await installDesktopCliCommand({
			platform: "win32",
			target: fixture.target,
			home: fixture.home,
			userData: fixture.userData,
			localAppData: fixture.root,
			environmentPath: "",
			launcherPath: launcher,
			execute: async (command, args, options) => {
				calls.push({ command, args, env: options?.env });
				return { stdout: "", stderr: "" };
			},
		});

		expect(result).toEqual({ status: "installed", path: launcher, pathReady: true });
		expect(readFileSync(launcher, "utf8")).toContain("Clawdi Desktop CLI launcher v1");
		expect(readFileSync(launcher, "utf8")).toContain(`"${fixture.target}" %*`);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("powershell.exe");
		expect(calls[0]?.env?.CLAWDI_DESKTOP_CLI_BIN).toBe(dirname(launcher));

		const nextTarget = join(fixture.root, "next", "clawdi.exe");
		mkdirSync(dirname(nextTarget), { recursive: true });
		writeFileSync(nextTarget, "binary");
		await installDesktopCliCommand({
			platform: "win32",
			target: nextTarget,
			home: fixture.home,
			userData: fixture.userData,
			localAppData: fixture.root,
			environmentPath: dirname(launcher),
			launcherPath: launcher,
			execute: async () => {
				throw new Error("PATH must not be changed twice");
			},
		});
		expect(readFileSync(launcher, "utf8")).toContain(`"${nextTarget}" %*`);
	});

	test("installs the macOS launcher in the user-local bin directory", async () => {
		const fixture = createFixture();
		const launcher = join(fixture.home, ".local", "bin", "clawdi");

		const result = await installDesktopCliCommand({
			platform: "darwin",
			target: fixture.target,
			home: fixture.home,
			userData: fixture.userData,
			environmentPath: dirname(launcher),
		});

		expect(result).toEqual({ status: "installed", path: launcher, pathReady: true });
		expect(resolve(dirname(launcher), readlinkSync(launcher))).toBe(fixture.target);
	});
});

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "clawdi-desktop-cli-command-"));
	roots.push(root);
	const home = join(root, "home");
	const userData = join(root, "data");
	const target = join(root, "app", "resources", "native", "clawdi");
	mkdirSync(dirname(target), { recursive: true });
	mkdirSync(home);
	mkdirSync(userData);
	writeFileSync(target, "binary");
	chmodSync(target, 0o755);
	return { root, home, userData, target };
}
