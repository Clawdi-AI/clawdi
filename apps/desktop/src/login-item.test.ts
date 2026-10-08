import { describe, expect, test } from "bun:test";
import type { App } from "electron";
import {
	readDesktopLoginItemSettings,
	setDesktopLaunchAtLogin,
	supportsDesktopLoginItems,
	wasDesktopOpenedAtLogin,
} from "./login-item";

function application(isPackaged = true, wasOpenedAtLogin = false) {
	const writes: Parameters<App["setLoginItemSettings"]>[0][] = [];
	const reads: Parameters<App["getLoginItemSettings"]>[0][] = [];
	const app = {
		isPackaged,
		getLoginItemSettings: (options?: Parameters<App["getLoginItemSettings"]>[0]) => {
			reads.push(options);
			return {
				openAtLogin: true,
				wasOpenedAtLogin,
				status: "enabled" as const,
				executableWillLaunchAtLogin: true,
				launchItems: [],
			};
		},
		setLoginItemSettings: (options: Parameters<App["setLoginItemSettings"]>[0]) => {
			writes.push(options);
		},
	};
	return { app, writes, reads };
}

describe("Desktop login items", () => {
	test("macOS keeps mainAppService and the OS login-launch flag", () => {
		const { app, writes, reads } = application(true, true);
		setDesktopLaunchAtLogin(app, true, "darwin");
		expect(writes).toEqual([{ openAtLogin: true, type: "mainAppService" }]);
		expect(wasDesktopOpenedAtLogin(app, "darwin", [])).toBe(true);
		expect(reads).toEqual([{ type: "mainAppService" }]);
	});

	test("Windows matches path/args when reading, and opens hidden through its login argument", () => {
		const { app, writes, reads } = application();
		const path = "C:\\Program Files\\Clawdi\\Clawdi.exe";
		setDesktopLaunchAtLogin(app, true, "win32", path);
		setDesktopLaunchAtLogin(app, false, "win32", path);
		readDesktopLoginItemSettings(app, "win32", path);
		const options = { path, args: ["--clawdi-opened-at-login"] };
		expect(writes).toEqual([
			{ openAtLogin: true, ...options },
			{ openAtLogin: false, ...options },
		]);
		expect(reads).toEqual([options]);
		expect(wasDesktopOpenedAtLogin(app, "win32", [path, ...options.args])).toBe(true);
		expect(wasDesktopOpenedAtLogin(app, "win32", [path])).toBe(false);
	});

	test.each(["darwin", "win32", "linux"] as const)(
		"%s development never touches login items",
		(platform) => {
			const { app, writes, reads } = application(false, true);
			setDesktopLaunchAtLogin(app, true, platform);
			expect(readDesktopLoginItemSettings(app, platform)).toBeNull();
			expect(wasDesktopOpenedAtLogin(app, platform, ["--clawdi-opened-at-login"])).toBe(false);
			expect(writes).toEqual([]);
			expect(reads).toEqual([]);
		},
	);

	test("Linux has no Electron login item or hidden launch behavior", () => {
		const { app, writes, reads } = application();
		setDesktopLaunchAtLogin(app, true, "linux");
		expect(readDesktopLoginItemSettings(app, "linux")).toBeNull();
		expect(wasDesktopOpenedAtLogin(app, "linux", ["--clawdi-opened-at-login"])).toBe(false);
		expect(supportsDesktopLoginItems("linux")).toBe(false);
		expect(supportsDesktopLoginItems("darwin")).toBe(true);
		expect(supportsDesktopLoginItems("win32")).toBe(true);
		expect(writes).toEqual([]);
		expect(reads).toEqual([]);
	});

	test("OS failures reach the caller's error boundary", () => {
		const { app } = application();
		app.setLoginItemSettings = () => {
			throw new Error("OS failure");
		};
		expect(() => setDesktopLaunchAtLogin(app, true, "win32")).toThrow("OS failure");
	});
});
