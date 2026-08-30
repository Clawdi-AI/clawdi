import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DesktopAgentType } from "@clawdi/shared/desktop";
import { isDesktopAgentType } from "@clawdi/shared/desktop";
import {
	app,
	BrowserWindow,
	type IpcMainInvokeEvent,
	ipcMain,
	Menu,
	type MenuItemConstructorOptions,
	nativeImage,
	session,
	shell,
	Tray,
} from "electron";
import { DESKTOP_IPC } from "./ipc";
import { DesktopCliError, DesktopCliService } from "./native-cli";

const DEFAULT_WEB_URL = "https://cloud.clawdi.ai";
const cli = new DesktopCliService();
let mainWindow: BrowserWindow | null = null;
let connectWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => void showAvailableWindow());
	void app.whenReady().then(startApplication);
}

async function startApplication(): Promise<void> {
	app.setName("Clawdi");
	registerIpc();
	configurePermissions();
	createApplicationMenu();
	createTray();
	try {
		const state = await cli.bootstrapState();
		if (state.auth.authenticated && state.daemon.running) {
			await prepareDashboardSession();
			await showMainWindow();
		} else {
			await showConnectWindow();
		}
	} catch (error) {
		console.error("Could not open the dashboard", error);
		await showConnectWindow();
	}

	app.on("activate", () => void showAvailableWindow());
	app.on("before-quit", () => {
		quitting = true;
	});
}

function registerIpc(): void {
	ipcMain.handle(DESKTOP_IPC.bootstrapState, (event) =>
		safeConnectAction(event, "prepare the local runtime", () => cli.bootstrapState()),
	);
	ipcMain.handle(DESKTOP_IPC.detectAgents, (event) =>
		safeConnectAction(event, "inspect local Agents", () => cli.detectAgents()),
	);
	ipcMain.handle(DESKTOP_IPC.authenticate, (event) =>
		safeConnectAction(event, "sign in", async () => {
			await cli.authenticate();
			return cli.bootstrapState();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.connectAgents, (event, rawAgentTypes: unknown) =>
		safeConnectAction(event, "connect the selected Agents", async () => {
			return cli.connectAgents(readAgentTypes(rawAgentTypes));
		}),
	);
	ipcMain.handle(DESKTOP_IPC.openDashboard, (event) =>
		safeConnectAction(event, "open the dashboard", async () => {
			await prepareDashboardSession();
			await showMainWindow();
			connectWindow?.hide();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.openConnectWizard, (event) =>
		safeDashboardAction(event, "open Connect Agent", async () => {
			await showConnectWindow();
			mainWindow?.hide();
		}),
	);
}

async function safeConnectAction<T>(
	event: IpcMainInvokeEvent,
	label: string,
	action: () => Promise<T>,
): Promise<T> {
	try {
		assertConnectSender(event);
		return await action();
	} catch (error) {
		console.error(`Could not ${label}`, error);
		if (error instanceof DesktopCliError) throw error;
		throw new Error(`Could not ${label}. Try again.`);
	}
}

async function safeDashboardAction<T>(
	event: IpcMainInvokeEvent,
	label: string,
	action: () => Promise<T>,
): Promise<T> {
	try {
		assertDashboardSender(event);
		return await action();
	} catch (error) {
		console.error(`Could not ${label}`, error);
		throw new Error(`Could not ${label}. Try again.`);
	}
}

function assertDashboardSender(event: IpcMainInvokeEvent): void {
	if (event.sender !== mainWindow?.webContents) throw new Error("Unexpected desktop client.");
	const senderUrl = event.senderFrame?.url;
	if (!senderUrl) throw new Error("Unexpected desktop client URL.");
	let senderOrigin: string;
	try {
		senderOrigin = new URL(senderUrl).origin;
	} catch {
		throw new Error("Unexpected desktop client URL.");
	}
	if (senderOrigin !== new URL(desktopWebUrl()).origin) {
		throw new Error("Unexpected desktop client origin.");
	}
}

function assertConnectSender(event: IpcMainInvokeEvent): void {
	if (event.sender !== connectWindow?.webContents)
		throw new Error("Unexpected Connect Agent client.");
	const senderUrl = event.senderFrame?.url;
	if (!senderUrl) throw new Error("Unexpected Connect Agent URL.");
	const expected = pathToFileURL(connectRendererPath());
	const sender = new URL(senderUrl);
	if (sender.protocol !== expected.protocol || sender.pathname !== expected.pathname) {
		throw new Error("Unexpected Connect Agent URL.");
	}
}

function readAgentTypes(value: unknown): DesktopAgentType[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("Choose at least one supported Agent.");
	}
	const agentTypes: DesktopAgentType[] = [];
	for (const type of value) {
		if (!isDesktopAgentType(type)) throw new Error("Choose at least one supported Agent.");
		agentTypes.push(type);
	}
	return agentTypes;
}

function configurePermissions(): void {
	session.defaultSession.setPermissionCheckHandler(() => false);
	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
		callback(false);
	});
}

function createApplicationMenu(): void {
	const editMenu: MenuItemConstructorOptions = {
		label: "Edit",
		submenu: [
			{ role: "undo" },
			{ role: "redo" },
			{ type: "separator" },
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" },
		],
	};
	const windowMenu: MenuItemConstructorOptions = {
		label: "Window",
		submenu: [
			{ role: "minimize" },
			{ role: "zoom" },
			{ type: "separator" },
			{ role: process.platform === "darwin" ? "front" : "close" },
		],
	};
	const template: MenuItemConstructorOptions[] = [editMenu, windowMenu];
	if (process.platform === "darwin") {
		template.unshift({
			label: app.name,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		});
	}
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(showOnReady = true, initialUrl = desktopWebUrl()): Promise<void> {
	const preload = join(fileURLToPath(new URL(".", import.meta.url)), "shell-preload.cjs");
	const icon = desktopIcon();
	const window = new BrowserWindow({
		width: 1320,
		height: 860,
		minWidth: 960,
		minHeight: 640,
		show: false,
		backgroundColor: "#ffffff",
		...(icon.isEmpty() ? {} : { icon }),
		webPreferences: {
			preload,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	mainWindow = window;

	const webUrl = desktopWebUrl();
	const trustedOrigin = new URL(webUrl).origin;
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (isSafeExternalUrl(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	const preventUntrustedNavigation = (event: Electron.Event, url: string) => {
		if (urlOrigin(url) !== trustedOrigin) {
			event.preventDefault();
			if (isSafeExternalUrl(url)) void shell.openExternal(url);
		}
	};
	window.webContents.on("will-navigate", preventUntrustedNavigation);
	window.webContents.on("will-redirect", preventUntrustedNavigation);
	window.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		window.hide();
	});
	if (showOnReady) window.once("ready-to-show", () => window.show());
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});

	await window.loadURL(initialUrl);
}

async function showConnectWindow(): Promise<void> {
	if (connectWindow) {
		if (connectWindow.isMinimized()) connectWindow.restore();
		connectWindow.show();
		connectWindow.focus();
		return;
	}

	const preload = join(fileURLToPath(new URL(".", import.meta.url)), "connect-preload.cjs");
	const icon = desktopIcon();
	const window = new BrowserWindow({
		width: 560,
		height: 680,
		minWidth: 480,
		minHeight: 560,
		show: false,
		backgroundColor: "#faf9f7",
		title: "Connect Agent",
		...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
		...(icon.isEmpty() ? {} : { icon }),
		webPreferences: {
			preload,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	connectWindow = window;
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", (event, url) => {
		if (new URL(url).pathname !== pathToFileURL(connectRendererPath()).pathname) {
			event.preventDefault();
		}
	});
	window.once("ready-to-show", () => window.show());
	window.on("closed", () => {
		if (connectWindow === window) connectWindow = null;
	});
	await window.loadFile(connectRendererPath());
}

function connectRendererPath(): string {
	return join(app.getAppPath(), "dist", "renderer.html");
}

function createTray(): void {
	const icon = desktopIcon();
	if (icon.isEmpty()) return;
	const trayIcon = icon.resize({ width: 18, height: 18 });
	if (process.platform === "darwin") trayIcon.setTemplateImage(true);
	tray = new Tray(trayIcon);
	tray.setToolTip("Clawdi");
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "Open Clawdi", click: showAvailableWindow },
			{
				label: "Connect Agent",
				click: () => void showConnectWindow(),
			},
			{ type: "separator" },
			{
				label: "Quit Clawdi",
				click: () => {
					quitting = true;
					app.quit();
				},
			},
		]),
	);
	tray.on("click", () => void showAvailableWindow());
}

async function showAvailableWindow(): Promise<void> {
	if (mainWindow) {
		await showMainWindow();
		return;
	}
	await showConnectWindow();
}

async function showMainWindow(): Promise<void> {
	if (!mainWindow) {
		await createMainWindow(true);
		return;
	}
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}

async function prepareDashboardSession(): Promise<void> {
	const ticket = await cli.createDashboardSession();
	const url = new URL("/desktop-auth", desktopWebUrl());
	url.hash = new URLSearchParams({ ticket }).toString();
	if (mainWindow) await mainWindow.loadURL(url.toString());
	else await createMainWindow(false, url.toString());
}

function desktopWebUrl(): string {
	const raw = app.isPackaged
		? packagedWebUrl() || DEFAULT_WEB_URL
		: process.env.CLAWDI_DESKTOP_WEB_URL?.trim() || DEFAULT_WEB_URL;
	const url = new URL(raw);
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username ||
		url.password
	) {
		throw new Error("CLAWDI_DESKTOP_WEB_URL must be HTTPS or a loopback development URL.");
	}
	return url.toString();
}

function packagedWebUrl(): string | null {
	if (!app.isPackaged) return null;
	const metadata: unknown = JSON.parse(
		readFileSync(join(app.getAppPath(), "package.json"), "utf8"),
	);
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return null;
	const value = Reflect.get(metadata, "clawdiWebUrl");
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function desktopIcon() {
	const path = app.isPackaged
		? join(process.resourcesPath, "clawdi-logo.png")
		: join(app.getAppPath(), "..", "web", "public", "clawdi-logo-transparent.png");
	return nativeImage.createFromPath(path);
}

function isSafeExternalUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
		return (
			(url.protocol === "https:" || (!app.isPackaged && url.protocol === "http:" && loopback)) &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

function urlOrigin(raw: string): string | null {
	try {
		return new URL(raw).origin;
	} catch {
		return null;
	}
}
