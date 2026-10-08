import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { DesktopUpdateController, type DesktopUpdater } from "./update-controller";
import { DesktopUpdateInstallation } from "./update-install";
import { desktopUpdateDownloadUrl, desktopUpdateNotification } from "./update-notification";
import type { DesktopUpdatePolicy } from "./update-policy";
import type { DesktopUpdateState } from "./update-state";

class FakeUpdater extends EventEmitter implements DesktopUpdater {
	autoDownload = false;
	autoInstallOnAppQuit = false;
	autoRunAppAfterInstall = true;
	channel = "latest";
	allowPrerelease = false;
	allowDowngrade = true;
	installs: (boolean | undefined)[][] = [];
	async checkForUpdates(): Promise<null> {
		this.emit("checking-for-update");
		return null;
	}
	quitAndInstall(...args: (boolean | undefined)[]): void {
		this.installs.push(args);
	}
}
const controllers: DesktopUpdateController[] = [];
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.stop();
});
function fixture(policy: DesktopUpdatePolicy = { enabled: true, channel: "stable" }) {
	const updater = new FakeUpdater();
	const states: DesktopUpdateState[] = [];
	const ready: string[] = [];
	const available: string[] = [];
	const controller = new DesktopUpdateController({
		policy,
		updater,
		onStateChange: (state) => states.push(state),
		onUpdateReady: (version) => ready.push(version),
		onUpdateAvailable: (version) => available.push(version),
	});
	controllers.push(controller);
	controller.start();
	return { controller, updater, states, ready, available };
}
async function download(f: ReturnType<typeof fixture>) {
	await f.controller.checkForUpdates();
	f.updater.emit("update-available", { version: "1.1.0" });
	f.updater.emit("update-downloaded", { version: "1.1.0" });
}

describe("Desktop updater", () => {
	test("notifies once per downloaded version; installs only when ready with default restart", async () => {
		const f = fixture();
		expect(f.controller.installDownloadedUpdate()).toBe(false);
		await download(f);
		f.updater.emit("update-downloaded", { version: "1.1.0" });
		expect(f.ready).toEqual(["1.1.0"]);
		expect(f.states.at(-1)).toEqual({ status: "ready", version: "1.1.0" });
		expect(f.controller.installDownloadedUpdate()).toBe(true);
		expect(f.controller.installDownloadedUpdate()).toBe(false);
		expect(f.updater.installs).toEqual([[]]);
		expect(f.updater.autoInstallOnAppQuit).toBe(true);
		expect(f.updater.allowDowngrade).toBe(false);
		expect(desktopUpdateNotification("1.1.0", true).body).toBe(
			"Clawdi Desktop 1.1.0 is ready — restart to update",
		);
	});
	test("DEB/RPM only check, deduplicate the download notice and never download/install", async () => {
		const f = fixture({ enabled: false, reason: "package-manager", channel: "beta" });
		await download(f);
		expect(f.updater.autoDownload).toBe(false);
		expect(f.updater.autoInstallOnAppQuit).toBe(false);
		expect(f.updater.channel).toBe("beta");
		expect(f.updater.allowDowngrade).toBe(false);
		expect(f.states.at(-1)).toEqual({ status: "available", version: "1.1.0" });
		expect(f.ready).toEqual([]);
		expect(f.available).toEqual(["1.1.0"]);
		await f.controller.checkForUpdates();
		f.updater.emit("update-available", { version: "1.1.0" });
		expect(f.available).toEqual(["1.1.0"]);
		expect(f.controller.installDownloadedUpdate()).toBe(false);
		expect(f.updater.installs).toEqual([]);
		expect(desktopUpdateDownloadUrl("1.1.0-beta.1")).toBe(
			"https://github.com/Clawdi-AI/clawdi/releases/tag/desktop-v1.1.0-beta.1",
		);
		expect(() => desktopUpdateDownloadUrl("../secret")).toThrow();
	});
	test("check failures expose only the error state and can be retried", async () => {
		const f = fixture();
		f.updater.checkForUpdates = () => Promise.reject(new Error("offline"));
		await f.controller.checkForUpdates();
		expect(f.states.at(-1)).toEqual({ status: "error" });
		f.updater.checkForUpdates = () => Promise.resolve(null);
		await f.controller.checkForUpdates();
	});
});

describe("background services during update installation", () => {
	function installation(
		platform: NodeJS.Platform = "win32",
		install: (onQuit: boolean) => boolean = () => true,
	) {
		const calls: string[] = [];
		const controller = new DesktopUpdateInstallation({
			platform,
			isReady: () => true,
			isBusy: () => false,
			stopBackgroundServices: async () => {
				calls.push("stop");
				return true;
			},
			restoreBackgroundServices: async () => {
				calls.push("restore");
			},
			install: (onQuit) => {
				calls.push(onQuit ? "quit-for-auto-install" : "quitAndInstall");
				return install(onQuit);
			},
		});
		return { controller, calls };
	}
	test("Windows quit waits for services and allows the upstream quit handler without relaunch", async () => {
		const f = installation();
		expect(f.controller.shouldDeferQuit()).toBe(true);
		await f.controller.install(true);
		expect(f.calls).toEqual(["stop", "quit-for-auto-install"]);
		expect(f.controller.shouldDeferQuit()).toBe(false);
		await f.controller.install(true);
		expect(f.calls).toHaveLength(2);
	});
	test("the Windows notification/menu action uses the same stop path", async () => {
		const f = installation();
		await f.controller.install(false);
		expect(f.calls).toEqual(["stop", "quitAndInstall"]);
	});
	test("macOS/Linux leave services running for both installation paths", async () => {
		for (const platform of ["darwin", "linux"] as const) {
			for (const onQuit of [true, false]) {
				const f = installation(platform);
				await f.controller.install(onQuit);
				expect(f.calls).toEqual([onQuit ? "quit-for-auto-install" : "quitAndInstall"]);
				expect(f.controller.shouldDeferQuit()).toBe(false);
			}
			const failed = installation(platform, () => false);
			await expect(failed.controller.install(false)).rejects.toThrow("no longer ready");
			expect(failed.calls).toEqual(["quitAndInstall"]);
			expect(failed.controller.shouldDeferQuit()).toBe(true);
		}
	});
	test("a failed install restores services, cancels quitting, and permits retry", async () => {
		const f = installation("win32", () => false);
		await expect(f.controller.install(false)).rejects.toThrow("no longer ready");
		expect(f.calls).toEqual(["stop", "quitAndInstall", "restore"]);
		expect(f.controller.shouldDeferQuit()).toBe(true);
	});
	test("quitting during a critical operation waits, then follows install-on-quit", async () => {
		let busy = true;
		const calls: string[] = [];
		const installation = new DesktopUpdateInstallation({
			platform: "win32",
			isReady: () => true,
			isBusy: () => busy,
			stopBackgroundServices: async () => {
				calls.push("stop");
				return false;
			},
			restoreBackgroundServices: async () => {
				calls.push("restore");
			},
			install: (onQuit) => {
				calls.push(onQuit ? "quit" : "restart");
				return true;
			},
		});
		expect(installation.shouldDeferQuit()).toBe(true);
		await installation.install(true);
		expect(calls).toEqual([]);
		busy = false;
		await installation.resumePendingQuit();
		expect(calls).toEqual(["stop", "quit"]);
	});
	test("failed service shutdown aborts installation without starting an unrelated service", async () => {
		const calls: string[] = [];
		const installation = new DesktopUpdateInstallation({
			platform: "win32",
			isReady: () => true,
			isBusy: () => false,
			stopBackgroundServices: () => Promise.reject(new Error("stop failed")),
			restoreBackgroundServices: async () => {
				calls.push("restore");
			},
			install: () => {
				calls.push("install");
				return true;
			},
		});
		await expect(installation.install(true)).rejects.toThrow("stop failed");
		expect(calls).toEqual([]);
		expect(installation.shouldDeferQuit()).toBe(true);
	});
});
