import { expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageBoxOptions } from "electron";
import {
	clearDesktopDirectories,
	macApplicationBundle,
	uninstallDesktop,
	windowsUninstaller,
} from "./uninstall";

function fixture(
	platform: NodeJS.Platform = "darwin",
	installedByDesktop = true,
	removeCli = true,
	response = 1,
) {
	const calls: string[] = [];
	const dialogs: MessageBoxOptions[] = [];
	const actions = {
		platform,
		installedByDesktop: async () => installedByDesktop,
		showMessageBox: async (options: MessageBoxOptions) => {
			dialogs.push(options);
			return { response, checkboxChecked: removeCli };
		},
		prepare: async () => {
			calls.push("prepare");
		},
		revokeSessions: async () => {
			calls.push("revoke");
		},
		uninstallCli: mock(async (remove: boolean) => {
			calls.push(`cli:${remove}`);
		}),
		clearData: async () => {
			calls.push("data");
		},
		removeLoginItem: () => {
			calls.push("login-item");
		},
		removeApplication: async () => {
			calls.push("application");
		},
		quit: () => {
			calls.push("quit");
		},
	};
	return { actions, calls, dialogs };
}

test.each([true, false])(
	"native confirmation defaults CLI removal to Desktop ownership %s and cancel changes nothing",
	async (installedByDesktop) => {
		const { actions, calls, dialogs } = fixture("darwin", installedByDesktop, true, 0);
		expect(await uninstallDesktop(actions)).toBe(false);
		expect(dialogs[0]?.checkboxChecked).toBe(installedByDesktop);
		expect(dialogs[0]?.checkboxLabel).toBe("Also remove the Clawdi command-line tool");
		expect(dialogs[0]?.detail).toContain("account data stays");
		expect(calls).toEqual([]);
	},
);

test.each([true, false])(
	"confirmation honors the checkbox %s and clears local data before removing the app",
	async (removeCli) => {
		const { actions, calls } = fixture("darwin", true, removeCli);
		expect(await uninstallDesktop(actions)).toBe(true);
		expect(calls).toEqual([
			"prepare",
			"revoke",
			`cli:${removeCli}`,
			"login-item",
			"data",
			"application",
			"quit",
		]);
	},
);

test("cleanup continues after CLI failure and reports it before quitting", async () => {
	const { actions, calls, dialogs } = fixture("win32");
	actions.uninstallCli = mock(async () => {
		throw new Error("private CLI error");
	});
	await uninstallDesktop(actions);
	expect(calls).toContain("data");
	expect(calls.at(-1)).toBe("quit");
	expect(dialogs[1]?.detail).toContain("Remove local services and integrations");
	expect(JSON.stringify(dialogs)).not.toContain("private CLI error");
});

test("Linux shows package and AppImage removal instructions before quitting", async () => {
	const { actions, calls, dialogs } = fixture("linux");
	await uninstallDesktop(actions);
	expect(dialogs.at(-1)?.detail).toContain("apt remove clawdi-desktop");
	expect(dialogs.at(-1)?.detail).toContain("AppImage");
	expect(calls.at(-1)).toBe("quit");
});

test("resolves platform application removal targets", () => {
	const root = join(tmpdir(), "Clawdi.app");
	expect(macApplicationBundle(join(root, "Contents/MacOS/Clawdi"))).toBe(root);
	expect(() => macApplicationBundle(join(tmpdir(), "bin/clawdi"))).toThrow("app bundle");
	expect(windowsUninstaller(join(tmpdir(), "Clawdi/Clawdi.exe"))).toBe(
		join(tmpdir(), "Clawdi/Uninstall Clawdi.exe"),
	);
});

test("clears settings, partition files, and logs without touching adjacent data", async () => {
	const root = mkdtempSync(join(tmpdir(), "desktop-uninstall-"));
	try {
		for (const directory of ["app/Partitions", "logs", "other-app"]) {
			mkdirSync(join(root, directory), { recursive: true });
			writeFileSync(join(root, directory, "data"), "fixture");
		}
		await clearDesktopDirectories(
			[join(root, "app"), join(root, "logs"), join(root, "app")],
			"linux",
		);
		expect(existsSync(join(root, "app"))).toBe(false);
		expect(existsSync(join(root, "logs"))).toBe(false);
		expect(existsSync(join(root, "other-app/data"))).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Desktop still quits when a post-cleanup native dialog fails", async () => {
	const { actions, calls } = fixture("linux");
	const confirm = actions.showMessageBox;
	actions.showMessageBox = async (options) => {
		if (options.message === "Remove the Clawdi app") throw new Error("dialog failed");
		return confirm(options);
	};
	await expect(uninstallDesktop(actions)).rejects.toThrow("dialog failed");
	expect(calls.at(-1)).toBe("quit");
});
