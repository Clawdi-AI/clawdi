import { expect, test } from "bun:test";
import { desktopDaemonReconciliationAction, needsDaemonRuntimeRefresh } from "./daemon-runtime";

test("stopped AppImage old units install the new path once before startup restart", () => {
	const stopped = {
		installed: true,
		supervisorRunning: false,
		authenticated: true,
		alreadyReconciled: false,
		isAppImage: true,
		liveRuntimeMismatch: false,
	};
	expect(desktopDaemonReconciliationAction(stopped)).toBe("install");
	expect(desktopDaemonReconciliationAction({ ...stopped, supervisorRunning: true })).toBeNull();
	expect(
		desktopDaemonReconciliationAction({
			...stopped,
			supervisorRunning: true,
			liveRuntimeMismatch: true,
		}),
	).toBe("install");
	expect(desktopDaemonReconciliationAction({ ...stopped, alreadyReconciled: true })).toBeNull();
	expect(desktopDaemonReconciliationAction({ ...stopped, isAppImage: false })).toBeNull();
	expect(desktopDaemonReconciliationAction({ ...stopped, installed: false })).toBeNull();
	expect(desktopDaemonReconciliationAction({ ...stopped, authenticated: false })).toBeNull();
	expect(
		desktopDaemonReconciliationAction({ ...stopped, isAppImage: false, liveRuntimeMismatch: true }),
	).toBe("install");
});

test("manual upgrades refresh an older daemon on every platform, but matching runtimes stay untouched", () => {
	for (const [platform, executable] of [
		["darwin", "/Applications/Clawdi.app/Contents/Resources/native/clawdi"],
		["linux", "/opt/Clawdi/resources/native/clawdi"],
		["win32", "C:\\Users\\User\\Clawdi\\resources\\native\\clawdi.exe"],
	] as const) {
		expect(
			needsDaemonRuntimeRefresh("1.2.0", executable, [{ version: "1.1.0", executable }], platform),
		).toBe(true);
		expect(
			needsDaemonRuntimeRefresh("1.2.0", executable, [{ version: "1.2.0", executable }], platform),
		).toBe(false);
		expect(
			needsDaemonRuntimeRefresh(
				"1.2.0",
				executable,
				[{ version: null, executable: null }],
				platform,
			),
		).toBe(true);
		expect(needsDaemonRuntimeRefresh("1.2.0", executable, [], platform)).toBe(false);
	}
});

test("moved bundles and AppImage generations refresh even without a CLI version bump", () => {
	expect(
		needsDaemonRuntimeRefresh(
			"1.2.0",
			"/data/runtimes/2.0.0/clawdi",
			[{ version: "1.2.0", executable: "/data/runtimes/1.0.0/clawdi" }],
			"linux",
		),
	).toBe(true);
	expect(
		needsDaemonRuntimeRefresh(
			"1.2.0",
			"/Applications/Clawdi.app/clawdi",
			[{ version: "1.2.0", executable: "/Applications/Old.app/clawdi" }],
			"darwin",
		),
	).toBe(true);
	expect(
		needsDaemonRuntimeRefresh(
			"1.2.0",
			"C:\\Clawdi\\clawdi.exe",
			[{ version: "1.2.0", executable: "c:/clawdi/clawdi.exe" }],
			"win32",
		),
	).toBe(false);
	expect(
		needsDaemonRuntimeRefresh(
			"1.2.0",
			"/app/clawdi",
			[{ version: "1.2.0", executable: null }],
			"linux",
		),
	).toBe(true);
});
