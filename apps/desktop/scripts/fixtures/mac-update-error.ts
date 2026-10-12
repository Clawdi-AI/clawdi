import { mock } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import type { AppAdapter } from "electron-updater/out/AppAdapter";
import { DesktopMutations } from "../../src/mutations";
import { DesktopUpdateController } from "../../src/update-controller";
import { DesktopUpdateInstallation } from "../../src/update-install";
import type { DesktopUpdateState } from "../../src/update-state";

// Run in a child so the Electron boundary mock cannot affect other tests.
const nativeUpdater = new EventEmitter();
let nativeInstalls = 0;
let appQuits = 0;
mock.module("electron", () => ({
	autoUpdater: Object.assign(nativeUpdater, {
		quitAndInstall: () => nativeInstalls++,
		checkForUpdates: () => undefined,
	}),
}));
const { MacUpdater } = await import("electron-updater/out/MacUpdater");
const app: AppAdapter = {
	version: "1.0.0",
	name: "update-error-fixture",
	isPackaged: true,
	appUpdateConfigPath: "unused",
	userDataPath: tmpdir(),
	baseCachePath: tmpdir(),
	whenReady: async () => undefined,
	relaunch: () => undefined,
	quit: () => appQuits++,
	onQuit: () => undefined,
};

for (const platform of ["darwin", "win32"] as const) {
	const updater = new MacUpdater(undefined, app);
	updater.logger = null;
	const mutations = new DesktopMutations();
	const states: DesktopUpdateState[] = [];
	const calls: string[] = [];
	const restored = Promise.withResolvers<void>();
	let recovery = Promise.resolve();
	const controller = new DesktopUpdateController({
		policy: { mode: "install" },
		updater,
		onStateChange: (state) => states.push(state),
		onUpdateReady: () => undefined,
		onInstallError: () => {
			recovery = installation.recoverAfterFailure();
		},
	});
	const installation = new DesktopUpdateInstallation({
		platform,
		mutations,
		isReady: () => states.at(-1)?.status === "ready",
		stopBackgroundServices: async () => {
			calls.push("stop");
			return true;
		},
		restoreBackgroundServices: async () => {
			calls.push("restore");
			await restored.promise;
		},
		install: () => controller.installDownloadedUpdate(),
	});
	controller.start();
	try {
		const download = () => {
			const info = {
				version: "1.1.0",
				files: [],
				path: "fixture.zip",
				sha512: "fixture",
				releaseDate: "2026-10-11T00:00:00Z",
			};
			updater.emit("checking-for-update");
			updater.emit("update-available", info);
			// MacUpdater emits this before Squirrel's native update-downloaded.
			updater.emit("update-downloaded", { ...info, downloadedFile: "unused" });
		};
		download();
		await installation.install(false);
		assert.equal(nativeInstalls, 0);
		assert.equal(appQuits, 0);
		assert.equal(
			mutations.blocked,
			true,
			"Returning from quitAndInstall must keep admission closed",
		);
		await assert.rejects(
			mutations.run(async () => undefined),
			/preparing an update/,
		);
		// Actual MacUpdater forwarding, on a later event turn after the void return.
		await new Promise<void>((done) => setImmediate(done));
		nativeUpdater.emit(
			"error",
			new Error("Squirrel validation failed after quitAndInstall returned"),
		);
		if (platform === "win32") {
			assert.equal(
				mutations.blocked,
				true,
				"Keep admission closed until service recovery completes",
			);
			await assert.rejects(
				mutations.run(async () => undefined),
				/preparing an update/,
			);
		}
		restored.resolve();
		await recovery;
		assert.deepEqual(states.at(-1), { status: "error" });
		assert.equal(mutations.blocked, false);
		await mutations.run(async () => calls.push("Connect"));
		await mutations.run(async () => calls.push("sign-out"));
		assert.deepEqual(calls.slice(-2), ["Connect", "sign-out"]);
		assert.equal(calls.filter((call) => call === "restore").length, platform === "win32" ? 1 : 0);
		download();
		await installation.install(false);
		assert.equal(mutations.blocked, true, "Retry must be accepted by both objects");
		nativeUpdater.emit("error", new Error("End fixture retry"));
		await recovery;
		assert.equal(mutations.blocked, false);
	} finally {
		controller.stop();
		updater.removeAllListeners();
		nativeUpdater.removeAllListeners();
	}
}
console.log(
	"MacUpdater deferred native error: recovery, Windows restore, mutations and retry passed",
);
