import type { App } from "electron";

type LoginItemApp = Pick<App, "isPackaged" | "getLoginItemSettings" | "setLoginItemSettings">;
const HIDDEN_LOGIN_ARGUMENT = "--clawdi-opened-at-login";

/** Use for menu visibility; Electron does not implement Linux login items. */
export function supportsDesktopLoginItems(platform = process.platform): boolean {
	return platform === "darwin" || platform === "win32";
}

function loginItemOptions(platform: NodeJS.Platform, executable: string) {
	return platform === "darwin"
		? { type: "mainAppService" as const }
		: { path: executable, args: [HIDDEN_LOGIN_ARGUMENT] };
}

/** Same Windows path/args must be passed to both Electron APIs. NSIS uses the app exe. */
export function readDesktopLoginItemSettings(
	application: LoginItemApp,
	platform = process.platform,
	executable = process.execPath,
): ReturnType<App["getLoginItemSettings"]> | null {
	if (!application.isPackaged || !supportsDesktopLoginItems(platform)) return null;
	return application.getLoginItemSettings(loginItemOptions(platform, executable));
}

/** The caller owns macOS's move-to-Applications gate and error presentation. */
export function setDesktopLaunchAtLogin(
	application: LoginItemApp,
	enabled: boolean,
	platform = process.platform,
	executable = process.execPath,
): void {
	if (!application.isPackaged || !supportsDesktopLoginItems(platform)) return;
	application.setLoginItemSettings({
		openAtLogin: enabled,
		...loginItemOptions(platform, executable),
	});
}

/** wasOpenedAtLogin is macOS-only; Windows carries our hidden flag in official args. */
export function wasDesktopOpenedAtLogin(
	application: LoginItemApp,
	platform = process.platform,
	argv: readonly string[] = process.argv,
): boolean {
	if (!application.isPackaged) return false;
	if (platform === "win32") return argv.includes(HIDDEN_LOGIN_ARGUMENT);
	if (platform === "darwin")
		return readDesktopLoginItemSettings(application, platform)?.wasOpenedAtLogin === true;
	return false;
}
