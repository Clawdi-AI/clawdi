import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, Menu, type MenuItem } from "electron";

// This fixture wraps the production main entry; no update APIs are replaced.
// Only the bundled CLI is fake, so this test cannot prove real service recovery.
app.disableHardwareAcceleration();
const productionMain = "./desktop-main.js";
await import(productionMain);
const phase = process.env.CLAWDI_DESKTOP_UPDATE_E2E_PHASE;
const resultPath = process.env.CLAWDI_DESKTOP_UPDATE_E2E_RESULT;
if (!resultPath) throw new Error("Missing e2e result path.");

function menuItems(items: readonly MenuItem[]): MenuItem[] {
	return items.flatMap((item) => [item, ...menuItems(item.submenu?.items ?? [])]);
}
function downloadedImages(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory()
			? downloadedImages(path)
			: entry.name.endsWith(".AppImage")
				? [path]
				: [];
	});
}

const deadline = Date.now() + 90_000;
const timer = setInterval(() => {
	try {
		if (!app.isReady()) return;
		// Keep Connect hidden, as a tray user would, so the optional modal is not
		// involved. Notification/menu and the production before-quit still run.
		for (const window of BrowserWindow.getAllWindows()) window.hide();
		const items = menuItems(Menu.getApplicationMenu()?.items ?? []);
		if (phase === "download" && items.some((item) => item.label === "Restart to Install Update")) {
			if (app.getVersion() !== "0.0.1") throw new Error("Unexpected automatic relaunch.");
			const images = downloadedImages(join(app.getPath("home"), ".cache"));
			const downloaded = images.find(
				(image) =>
					createHash("sha512").update(readFileSync(image)).digest("base64") ===
					process.env.CLAWDI_DESKTOP_UPDATE_E2E_SHA512,
			);
			if (!downloaded)
				throw new Error("The updater cache does not contain the SHA-512-pinned N+1 image.");
			writeFileSync(resultPath, JSON.stringify({ version: app.getVersion(), downloaded }));
			clearInterval(timer);
			app.quit(); // Exercise production before-quit + autoInstallOnAppQuit.
		} else if (phase === "notice" && items.some((item) => item.label === "Download New Version…")) {
			writeFileSync(resultPath, JSON.stringify({ version: app.getVersion(), notice: true }));
			clearInterval(timer);
			app.quit(); // Package-manager installs cannot run an updater installer.
		} else if (phase === "verify" && items.some((item) => item.label === "Check for Updates…")) {
			if (app.getVersion() !== "0.0.2")
				throw new Error("The installed AppImage did not report N+1.");
			writeFileSync(resultPath, JSON.stringify({ version: app.getVersion() }));
			clearInterval(timer);
			app.exit(0);
		} else if (Date.now() > deadline)
			throw new Error("Timed out waiting for the production updater.");
	} catch (error) {
		console.error(error);
		clearInterval(timer);
		app.exit(1);
	}
}, 200);
