import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, Menu, type MenuItem, session, shell } from "electron";

const root = process.env.CLAWDI_DESKTOP_UPDATE_E2E_ROOT;
const result = process.env.CLAWDI_DESKTOP_UPDATE_E2E_RESULT;
if (!root || !result) throw new Error("Missing Windows e2e paths.");
app.setPath("userData", join(root, "userData"));
app.setPath("home", join(root, "home"));
app.disableHardwareAcceleration();
// The account is a fixture. Keep dashboard traffic local while the production
// main, updater, quit handling and service reconciliation run.
shell.openExternal = async () => undefined;
app.on("ready", () => {
	session.fromPartition("persist:clawdi-dashboard").protocol.handle(
		"https",
		() =>
			new Response("<!doctype html><title>Update fixture dashboard</title>", {
				headers: { "Content-Type": "text/html" },
			}),
	);
});
const productionMain = "./desktop-main.js";
await import(productionMain);

function menuItems(items: readonly MenuItem[]): MenuItem[] {
	return items.flatMap((item) => [item, ...menuItems(item.submenu?.items ?? [])]);
}
function installers(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? installers(path) : entry.name.endsWith(".exe") ? [path] : [];
	});
}

const deadline = Date.now() + 120_000;
const timer = setInterval(() => {
	try {
		if (Date.now() > deadline)
			throw new Error("Timed out waiting for Windows production updater/recovery.");
		if (!app.isReady()) return;
		for (const window of BrowserWindow.getAllWindows()) window.hide();
		const items = menuItems(Menu.getApplicationMenu()?.items ?? []);
		if (
			process.env.CLAWDI_DESKTOP_UPDATE_E2E_PHASE === "download" &&
			items.some((item) => item.label === "Restart to Update")
		) {
			if (app.getVersion() !== "0.0.1") throw new Error("Unexpected automatic relaunch.");
			const downloaded = installers(join(root, "local")).find(
				(path) =>
					createHash("sha512").update(readFileSync(path)).digest("base64") ===
					process.env.CLAWDI_DESKTOP_UPDATE_E2E_SHA512,
			);
			if (!downloaded) throw new Error("Missing SHA-512-pinned N+1 installer in updater cache.");
			const serviceStarts = readFileSync(join(root, "home/.clawdi/service-starts.log"), "utf8")
				.trim()
				.split("\n").length;
			writeFileSync(
				result,
				JSON.stringify({ version: app.getVersion(), downloaded, serviceStarts }),
			);
			clearInterval(timer);
			app.quit(); // Production stop-services path, then upstream silent install-on-quit.
		} else if (
			process.env.CLAWDI_DESKTOP_UPDATE_E2E_PHASE === "verify" &&
			items.some((item) => item.label === "Check for Updates…")
		) {
			if (app.getVersion() !== "0.0.2") throw new Error("Installed NSIS app did not report N+1.");
			const starts = join(root, "home/.clawdi/service-starts.log");
			if (
				!existsSync(starts) ||
				readFileSync(starts, "utf8").trim().split("\n").length <=
					Number(process.env.CLAWDI_DESKTOP_UPDATE_E2E_PREVIOUS_STARTS)
			)
				return;
			writeFileSync(result, JSON.stringify({ version: app.getVersion(), serviceResumed: true }));
			clearInterval(timer);
			app.exit(0);
		}
	} catch (error) {
		console.error(error);
		clearInterval(timer);
		app.exit(1);
	}
}, 500);
