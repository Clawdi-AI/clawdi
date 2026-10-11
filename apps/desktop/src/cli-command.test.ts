import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
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
import {
	installDesktopCliCommand,
	migrateWindowsDesktopCliCommand,
	reconcileWindowsNativeCliCommand,
	removeDesktopCliSymlink,
} from "./cli-command";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Desktop CLI command", () => {
	test.skipIf(process.platform === "win32")(
		"migration recognizes a removed runtime when userdata has a directory alias",
		() => {
			const fixture = createFixture();
			const alias = join(fixture.root, "data-alias");
			symlinkSync(fixture.userData, alias);
			const launcher = join(fixture.home, ".local", "bin", "clawdi");
			mkdirSync(dirname(launcher), { recursive: true });
			symlinkSync(join(alias, "runtimes", "0.1.0", "clawdi"), launcher);
			removeDesktopCliSymlink({ home: fixture.home, userData: alias, bundledCli: fixture.target });
			expect(() => lstatSync(launcher)).toThrow();
		},
	);
	test.skipIf(process.platform === "win32")(
		"migration removes only symlinks into Desktop bundles or owned AppImage runtimes",
		() => {
			const fixture = createFixture();
			const launcher = join(fixture.home, ".local", "bin", "clawdi");
			mkdirSync(dirname(launcher), { recursive: true });
			const migrate = () =>
				removeDesktopCliSymlink({
					home: fixture.home,
					userData: fixture.userData,
					bundledCli: fixture.target,
				});
			for (const target of [
				fixture.target,
				"/removed/Clawdi.app/Contents/Resources/native/clawdi",
				"/opt/Clawdi/resources/native/clawdi",
				join(fixture.userData, "runtimes", "0.1.0", "clawdi"),
			]) {
				symlinkSync(target, launcher);
				migrate();
				expect(() => lstatSync(launcher)).toThrow();
			}
			for (const target of [
				"/opt/homebrew/bin/clawdi",
				"../lib/node_modules/clawdi/dist/index.js",
				"../share/clawdi/versions/0.16.9-linux-x64/clawdi",
			]) {
				symlinkSync(target, launcher);
				migrate();
				expect(readlinkSync(launcher)).toBe(target);
				rmSync(launcher);
			}
			writeFileSync(launcher, "foreign command");
			migrate();
			expect(readFileSync(launcher, "utf8")).toBe("foreign command");
		},
	);

	test("fresh Windows native reconciliation uses the existing marked shim and PATH helper", async () => {
		const fixture = createFixture();
		const launcher = join(fixture.root, "Clawdi", "bin", "clawdi.cmd");
		const helper = join(fixture.root, "windows-cli-path.ps1");
		writeFileSync(helper, "fixture");
		const argumentsReceived: string[][] = [];
		const options = {
			platform: "win32" as const,
			target: fixture.target,
			home: fixture.home,
			userData: fixture.userData,
			localAppData: fixture.root,
			environmentPath: "",
			windowsPathScript: helper,
			execute: async (_command: string, args: readonly string[]) => {
				argumentsReceived.push([...args]);
				return { stdout: "", stderr: "" };
			},
		};
		await reconcileWindowsNativeCliCommand(options);
		expect(readFileSync(launcher, "utf8")).toContain("@rem Clawdi Desktop CLI launcher v1");
		expect(argumentsReceived[0]).toContain(helper);
		expect(argumentsReceived[0]).toContain("Add");
		await reconcileWindowsNativeCliCommand(options);
		expect(argumentsReceived).toHaveLength(1);
		writeFileSync(launcher, "foreign command");
		await reconcileWindowsNativeCliCommand(options);
		expect(readFileSync(launcher, "utf8")).toBe("foreign command");
	});

	test("Windows migration repoints a marker shim to the stable launcher without adding a new shim", () => {
		const fixture = createFixture();
		const target = join(fixture.home, ".local", "share", "clawdi", "current", "clawdi.exe");
		const launcher = join(fixture.root, "Clawdi", "bin", "clawdi.cmd");
		const migrate = () => migrateWindowsDesktopCliCommand({ localAppData: fixture.root, target });
		migrate();
		expect(existsSync(launcher)).toBe(false);
		mkdirSync(dirname(launcher), { recursive: true });
		writeFileSync(launcher, '@rem Clawdi Desktop CLI launcher v1\r\n@echo off\r\n"old.exe" %*\r\n');
		migrate();
		expect(readFileSync(launcher, "utf8")).toContain(`"${target}" %*`);
		writeFileSync(launcher, "foreign command");
		migrate();
		expect(readFileSync(launcher, "utf8")).toBe("foreign command");
	});
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
		await installDesktopCliCommand({
			platform: "linux",
			target: nextTarget,
			home: fixture.home,
			userData: fixture.userData,
			environmentPath: "",
		});

		expect(resolve(dirname(launcher), readlinkSync(launcher))).toBe(nextTarget);
	});

	test("refreshes an obsolete launcher owned by a previous Desktop install", async () => {
		const fixture = createFixture();
		const launcher = join(fixture.home, ".local", "bin", "clawdi");
		mkdirSync(dirname(launcher), { recursive: true });
		symlinkSync("/Applications/Clawdi.app/Contents/Resources/native/clawdi", launcher);

		await installDesktopCliCommand({
			platform: "darwin",
			target: fixture.target,
			home: fixture.home,
			userData: fixture.userData,
			environmentPath: "",
		});

		expect(resolve(dirname(launcher), readlinkSync(launcher))).toBe(fixture.target);
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
			windowsPathScript: fixture.windowsPathScript,
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
		expect(calls[0]?.args).toContain(fixture.windowsPathScript);
		expect(calls[0]?.args).toContain(dirname(launcher));

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
			windowsPathScript: fixture.windowsPathScript,
			execute: async () => {
				throw new Error("PATH must not be changed twice");
			},
		});
		expect(readFileSync(launcher, "utf8")).toContain(`"${nextTarget}" %*`);
	});

	test.skipIf(process.platform === "win32")(
		"installs the macOS launcher in the user-local bin directory",
		async () => {
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
		},
	);
});

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "clawdi-desktop-cli-command-"));
	roots.push(root);
	const home = join(root, "home");
	const userData = join(root, "data");
	const target = join(root, "app", "resources", "native", "clawdi");
	const windowsPathScript = join(root, "windows-cli-path.ps1");
	mkdirSync(dirname(target), { recursive: true });
	mkdirSync(home);
	mkdirSync(userData);
	writeFileSync(target, "binary");
	writeFileSync(windowsPathScript, "param()\n");
	chmodSync(target, 0o755);
	return { root, home, userData, target, windowsPathScript };
}
