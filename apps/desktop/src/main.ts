import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	DesktopAgentType,
	DesktopBootstrapState,
	DesktopInstallationState,
	DesktopMoveToApplicationsResult,
} from "@clawdi/shared/desktop";
import { isDesktopAgentType } from "@clawdi/shared/desktop";
import {
	app,
	BrowserWindow,
	dialog,
	type IpcMainInvokeEvent,
	ipcMain,
	Menu,
	type MenuItemConstructorOptions,
	nativeImage,
	net,
	protocol,
	type Session,
	session,
	shell,
	Tray,
} from "electron";
import { DESKTOP_IPC } from "./ipc";
import { DesktopCliError, DesktopCliService } from "./native-cli";

const DEFAULT_WEB_URL = "https://cloud.clawdi.ai";
const CONNECT_SCHEME = "clawdi-app";
const CONNECT_HOST = "connect";
const CONNECT_RENDERER_URL = `${CONNECT_SCHEME}://${CONNECT_HOST}/renderer.html`;
const DASHBOARD_FAILURE_URL = `${CONNECT_RENDERER_URL}?surface=dashboard-failure`;
const DASHBOARD_PARTITION = "persist:clawdi-dashboard";
const ERR_ABORTED = -3;
const CONNECT_ASSETS = new Map([
	["/renderer.html", "renderer.html"],
	["/connect-renderer.js", "connect-renderer.js"],
	["/connect-renderer.css", "connect-renderer.css"],
]);
const cli = new DesktopCliService();
let mainWindow: BrowserWindow | null = null;
let connectWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayState: DesktopBootstrapState | null = null;
let trayStateChecking = true;
let trayStateRefresh: Promise<void> | null = null;
let availableWindowOpening: Promise<void> | null = null;
let dashboardWindowOpening: Promise<boolean> | null = null;
let dashboardFailureOpening: Promise<void> | null = null;
let quitting = false;

class DesktopConnectError extends Error {}

protocol.registerSchemesAsPrivileged([
	{
		scheme: CONNECT_SCHEME,
		privileges: { standard: true, secure: true, supportFetchAPI: true },
	},
]);

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("window-all-closed", () => undefined);
	app.on("second-instance", () => void showAvailableWindow());
	void app.whenReady().then(startApplication);
}

async function startApplication(): Promise<void> {
	app.setName("Clawdi");
	const startHidden = wasOpenedAtLogin();
	if (startHidden && process.platform === "darwin") app.dock?.hide();
	const dashboardSession = session.fromPartition(DASHBOARD_PARTITION);
	registerLocalProtocol(session.defaultSession);
	registerLocalProtocol(dashboardSession);
	registerIpc();
	configurePermissions(dashboardSession);
	createApplicationMenu();
	createTray();
	app.on("before-quit", () => {
		quitting = true;
		void cli.cancelAuthentication();
	});

	try {
		const state = await cli.bootstrapState();
		setTrayState(state);
		if (!startHidden) {
			if (state.auth.authenticated && state.daemon.running) {
				await loadDashboardWithRecovery();
			} else {
				await showConnectWindow();
			}
		}
	} catch (error) {
		console.error("Could not open the dashboard", error);
		setTrayState(null);
		if (!startHidden) await showConnectWindow();
	}

	app.on("activate", () => void showAvailableWindow());
}

function registerLocalProtocol(targetSession: Session): void {
	targetSession.protocol.handle(CONNECT_SCHEME, (request) => {
		const url = new URL(request.url);
		const asset = url.host === CONNECT_HOST ? CONNECT_ASSETS.get(url.pathname) : null;
		if (request.method !== "GET" || !asset) return new Response(null, { status: 404 });
		return net.fetch(pathToFileURL(join(app.getAppPath(), "dist", asset)).toString());
	});
}

function registerIpc(): void {
	ipcMain.handle(DESKTOP_IPC.bootstrapState, (event) =>
		safeConnectAction(event, "prepare the local runtime", async () => {
			const state = await cli.bootstrapState();
			setTrayState(state);
			return state;
		}),
	);
	ipcMain.handle(DESKTOP_IPC.installationState, (event) =>
		safeConnectAction(event, "check the app location", async () => installationState()),
	);
	ipcMain.handle(DESKTOP_IPC.detectAgents, (event) =>
		safeConnectAction(event, "inspect local Agents", () => cli.detectAgents()),
	);
	ipcMain.handle(DESKTOP_IPC.authenticate, (event) =>
		safeConnectAction(event, "sign in", async () => {
			if ((await cli.authenticate()) === "cancelled") return { status: "cancelled" as const };
			const state = await cli.bootstrapState();
			setTrayState(state);
			return { status: "authenticated" as const, state };
		}),
	);
	ipcMain.handle(DESKTOP_IPC.cancelAuthentication, (event) =>
		safeConnectAction(event, "cancel sign-in", async () => ({
			status: await cli.cancelAuthentication(),
		})),
	);
	ipcMain.handle(DESKTOP_IPC.connectAgents, (event, rawAgentTypes: unknown) =>
		safeConnectAction(event, "connect the selected Agents", async () => {
			assertSafeDaemonMutation();
			const result = await cli.connectAgents(readAgentTypes(rawAgentTypes));
			void refreshTrayState();
			return result;
		}),
	);
	ipcMain.handle(DESKTOP_IPC.moveToApplicationsFolder, (event) =>
		safeConnectAction(event, "move Clawdi to Applications", async () => moveToApplicationsFolder()),
	);
	ipcMain.handle(DESKTOP_IPC.openDashboard, (event) =>
		safeConnectAction(event, "open the dashboard", async () => {
			await loadDashboardWithRecovery();
			connectWindow?.hide();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.openConnectWizard, (event) =>
		safeDashboardAction(event, "open Connect Agent", async () => {
			await showConnectWindow();
			mainWindow?.hide();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.retryDashboard, (event) =>
		safeDashboardAction(event, "reconnect the dashboard", async () => {
			if (!(await loadDashboardWithRecovery())) {
				throw new Error("Dashboard reconnection failed.");
			}
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
		if (error instanceof DesktopCliError || error instanceof DesktopConnectError) throw error;
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
	const senderFrame = event.senderFrame;
	if (!senderFrame || senderFrame !== event.sender.mainFrame)
		throw new Error("Unexpected desktop client frame.");
	const senderUrl = senderFrame.url;
	if (senderUrl === DASHBOARD_FAILURE_URL) return;
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
	const senderFrame = event.senderFrame;
	if (!senderFrame || senderFrame !== event.sender.mainFrame)
		throw new Error("Unexpected Connect Agent frame.");
	const senderUrl = senderFrame.url;
	if (senderUrl !== CONNECT_RENDERER_URL) {
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

function configurePermissions(dashboardSession: Session): void {
	session.defaultSession.setPermissionCheckHandler(() => false);
	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
		callback(false);
	});

	const dashboardOrigin = new URL(desktopWebUrl()).origin;
	const allowsClipboardWrite = (
		webContents: Electron.WebContents | null,
		permission: string,
		requestingUrl: string,
		embeddingUrl: string,
	) =>
		permission === "clipboard-sanitized-write" &&
		webContents !== null &&
		webContents === mainWindow?.webContents &&
		urlOrigin(webContents.getURL()) === dashboardOrigin &&
		urlOrigin(requestingUrl) === dashboardOrigin &&
		urlOrigin(embeddingUrl) === dashboardOrigin;
	dashboardSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
		allowsClipboardWrite(
			webContents,
			permission,
			requestingOrigin,
			details.embeddingOrigin ?? requestingOrigin,
		),
	);
	dashboardSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
		callback(
			allowsClipboardWrite(webContents, permission, details.requestingUrl, webContents.getURL()),
		);
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

async function createMainWindow(initialUrl: string): Promise<void> {
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
			partition: DASHBOARD_PARTITION,
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
		if (url !== DASHBOARD_FAILURE_URL && urlOrigin(url) !== trustedOrigin) {
			event.preventDefault();
			if (isSafeExternalUrl(url)) void shell.openExternal(url);
		}
	};
	window.webContents.on("will-navigate", preventUntrustedNavigation);
	window.webContents.on("will-redirect", preventUntrustedNavigation);
	window.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
			if (
				quitting ||
				!isMainFrame ||
				errorCode === ERR_ABORTED ||
				validatedUrl === DASHBOARD_FAILURE_URL ||
				mainWindow !== window
			)
				return;
			console.error(`Dashboard failed to load: ${errorDescription} (${errorCode})`);
			void showDashboardFailure().catch((error) =>
				console.error("Could not show the dashboard recovery page", error),
			);
		},
	);
	window.webContents.on("render-process-gone", (_event, details) => {
		if (quitting || mainWindow !== window) return;
		console.error(`Dashboard renderer exited: ${details.reason}`);
		void showDashboardFailure(true).catch((error) =>
			console.error("Could not show the dashboard recovery page", error),
		);
	});
	window.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		window.hide();
	});
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});

	await window.loadURL(initialUrl);
}

async function showConnectWindow(): Promise<void> {
	if (process.platform === "darwin") await app.dock?.show();
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
		if (url !== CONNECT_RENDERER_URL) event.preventDefault();
	});
	window.once("ready-to-show", () => window.show());
	window.on("closed", () => {
		void cli.cancelAuthentication();
		if (connectWindow === window) connectWindow = null;
	});
	await window.loadURL(CONNECT_RENDERER_URL);
}

function createTray(): void {
	const icon = desktopIcon();
	if (icon.isEmpty()) return;
	const trayIcon = icon.resize({ width: 18, height: 18 });
	if (process.platform === "darwin") trayIcon.setTemplateImage(true);
	tray = new Tray(trayIcon);
	tray.setToolTip("Clawdi");
	renderTrayMenu();
	tray.on("click", () => void showAvailableWindow());
}

function renderTrayMenu(): void {
	if (!tray) return;
	const status = trayStatus();
	const recoveryLabel = trayState?.daemon.installed
		? "Restart Background Sync"
		: "Set Up Background Sync…";
	const template: MenuItemConstructorOptions[] = [
		{ label: status, enabled: false },
		{
			label: recoveryLabel,
			click: () =>
				void (trayState?.daemon.installed ? restartBackgroundSync() : showConnectWindow()),
		},
		{ label: "Refresh Status", click: () => void refreshTrayState() },
		{ type: "separator" },
		{ label: "Open Clawdi", click: showAvailableWindow },
		{ label: "Connect Agent…", click: () => void showConnectWindow() },
	];

	if (process.platform === "darwin") {
		const loginItem = readLoginItemSettings();
		template.push(
			{ type: "separator" },
			{
				type: "checkbox",
				label: "Open Clawdi at Login",
				checked: loginItem?.openAtLogin === true,
				enabled: app.isPackaged && loginItem !== null,
				click: (item) => void setLaunchAtLogin(item.checked),
			},
		);
		if (!loginItem) {
			template.push({ label: "Login Item: Unavailable", enabled: false });
		} else if (loginItem.status === "requires-approval") {
			template.push({ label: "Login Item Requires Approval", enabled: false });
		}
	}

	template.push(
		{ type: "separator" },
		{
			label: "Quit Clawdi",
			click: () => {
				quitting = true;
				app.quit();
			},
		},
	);
	tray.setContextMenu(Menu.buildFromTemplate(template));
}

function trayStatus(): string {
	if (trayStateChecking) return "Background Sync: Checking…";
	if (!trayState) return "Background Sync: Unavailable";
	if (!trayState.auth.authenticated) return "Background Sync: Sign In Required";
	if (!trayState.daemon.installed) return "Background Sync: Not Set Up";
	return trayState.daemon.running ? "Background Sync: Running" : "Background Sync: Needs Attention";
}

function setTrayState(state: DesktopBootstrapState | null): void {
	trayState = state;
	trayStateChecking = false;
	renderTrayMenu();
}

async function refreshTrayState(): Promise<void> {
	if (trayStateRefresh) return trayStateRefresh;
	trayStateChecking = true;
	renderTrayMenu();
	const refresh = (async () => {
		try {
			setTrayState(await cli.bootstrapState());
		} catch (error) {
			console.error("Could not refresh background sync status", error);
			setTrayState(null);
		}
	})();
	trayStateRefresh = refresh;
	try {
		await refresh;
	} finally {
		if (trayStateRefresh === refresh) trayStateRefresh = null;
	}
}

async function restartBackgroundSync(): Promise<void> {
	if (installationState().requiresMove) {
		await promptToMove("Clawdi must be in Applications before it can repair background sync.");
		return;
	}
	trayStateChecking = true;
	renderTrayMenu();
	try {
		await cli.restartDaemon();
		await refreshTrayState();
		setTimeout(() => void refreshTrayState(), 2_000).unref();
	} catch (error) {
		console.error("Could not restart background sync", error);
		setTrayState(null);
		const choice = await dialog.showMessageBox({
			type: "warning",
			message: "Background sync could not be restarted",
			detail: "Open Connect Agent to inspect and repair the local setup.",
			buttons: ["Open Connect Agent", "Cancel"],
			defaultId: 0,
			cancelId: 1,
		});
		if (choice.response === 0) await showConnectWindow();
	}
}

async function setLaunchAtLogin(enabled: boolean): Promise<void> {
	if (process.platform !== "darwin" || !app.isPackaged) {
		renderTrayMenu();
		return;
	}
	if (enabled && installationState().requiresMove) {
		renderTrayMenu();
		await promptToMove("Clawdi must be in Applications before it can open at login.");
		return;
	}
	try {
		app.setLoginItemSettings({ openAtLogin: enabled, type: "mainAppService" });
		const actual = readLoginItemSettings();
		if (!actual || actual.openAtLogin !== enabled) {
			await showLoginItemError();
		}
	} catch (error) {
		console.error("Could not change the login item", error);
		await showLoginItemError();
	}
	renderTrayMenu();
}

function readLoginItemSettings(): ReturnType<typeof app.getLoginItemSettings> | null {
	if (process.platform !== "darwin" || !app.isPackaged) return null;
	try {
		return app.getLoginItemSettings({ type: "mainAppService" });
	} catch (error) {
		console.error("Could not read the login item", error);
		return null;
	}
}

function wasOpenedAtLogin(): boolean {
	return app.isPackaged && readLoginItemSettings()?.wasOpenedAtLogin === true;
}

async function showLoginItemError(): Promise<void> {
	await dialog.showMessageBox({
		type: "warning",
		message: "The login item could not be changed",
		detail: "Review Clawdi in System Settings > General > Login Items and try again.",
	});
}

function installationState(): DesktopInstallationState {
	return {
		requiresMove: process.platform === "darwin" && app.isPackaged && !app.isInApplicationsFolder(),
	};
}

function assertSafeDaemonMutation(): void {
	if (!installationState().requiresMove) return;
	throw new DesktopConnectError(
		"Move Clawdi to Applications before connecting Agents or repairing background sync.",
	);
}

function moveToApplicationsFolder(): DesktopMoveToApplicationsResult {
	if (!installationState().requiresMove) return { status: "not-required" };
	const moved = app.moveToApplicationsFolder({
		conflictHandler: (conflictType) => {
			const running = conflictType === "existsAndRunning";
			return (
				dialog.showMessageBoxSync({
					type: "question",
					message: running
						? "Clawdi is already running from Applications"
						: "Replace the existing Clawdi app?",
					detail: running
						? "Open the installed copy and close this one. Background sync remains independent."
						: "The existing copy will be moved to the Trash before this copy is installed.",
					buttons: ["Cancel", running ? "Open Installed Clawdi" : "Replace and Move"],
					defaultId: 0,
					cancelId: 0,
					noLink: true,
				}) === 1
			);
		},
	});
	return { status: moved ? "relaunching" : "cancelled" };
}

async function promptToMove(detail: string): Promise<void> {
	const choice = await dialog.showMessageBox({
		type: "info",
		message: "Move Clawdi to Applications",
		detail: `${detail} Clawdi will reopen automatically after it moves.`,
		buttons: ["Not Now", "Move to Applications"],
		defaultId: 1,
		cancelId: 0,
		noLink: true,
	});
	if (choice.response !== 1) return;
	try {
		moveToApplicationsFolder();
	} catch (error) {
		console.error("Could not move Clawdi to Applications", error);
		await dialog.showMessageBox({
			type: "warning",
			message: "Clawdi could not be moved",
			detail: "Move Clawdi to Applications in Finder, reopen it, and try again.",
		});
	}
}

async function showAvailableWindow(): Promise<void> {
	if (mainWindow) {
		await showMainWindow();
		return;
	}
	if (connectWindow) {
		await showConnectWindow();
		return;
	}
	if (availableWindowOpening) return availableWindowOpening;

	const opening = showWindowFromTrayState();
	availableWindowOpening = opening;
	try {
		await opening;
	} finally {
		if (availableWindowOpening === opening) availableWindowOpening = null;
	}
}

async function showWindowFromTrayState(): Promise<void> {
	if (!trayState?.auth.authenticated || !trayState.daemon.running) {
		await showConnectWindow();
		return;
	}

	await loadDashboardWithRecovery();
}

async function showMainWindow(): Promise<void> {
	const window = mainWindow;
	if (!window || window.isDestroyed()) {
		await loadDashboardWithRecovery();
		return;
	}
	await presentMainWindow(window);
}

async function loadDashboardWithRecovery(): Promise<boolean> {
	if (dashboardWindowOpening) return dashboardWindowOpening;
	const opening = (async () => {
		try {
			await prepareDashboardSession();
			const window = mainWindow;
			if (!window || window.isDestroyed()) throw new Error("Dashboard window was closed");
			await presentMainWindow(window);
			return true;
		} catch (error) {
			console.error("Could not open the dashboard", error);
			await showDashboardFailure();
			return false;
		}
	})();
	dashboardWindowOpening = opening;
	try {
		return await opening;
	} finally {
		if (dashboardWindowOpening === opening) dashboardWindowOpening = null;
	}
}

async function showDashboardFailure(forceReload = false): Promise<void> {
	if (dashboardFailureOpening && !forceReload) return dashboardFailureOpening;
	const opening = (async () => {
		let window = mainWindow;
		if (!window || window.isDestroyed()) {
			await createMainWindow(DASHBOARD_FAILURE_URL);
			window = mainWindow;
		} else if (forceReload || window.webContents.getURL() !== DASHBOARD_FAILURE_URL) {
			await window.loadURL(DASHBOARD_FAILURE_URL);
		}
		if (!window || window.isDestroyed()) throw new Error("Dashboard recovery window was closed");
		await presentMainWindow(window);
	})();
	dashboardFailureOpening = opening;
	try {
		await opening;
	} finally {
		if (dashboardFailureOpening === opening) dashboardFailureOpening = null;
	}
}

async function presentMainWindow(window: BrowserWindow): Promise<void> {
	if (process.platform === "darwin") await app.dock?.show();
	if (window.isDestroyed()) throw new Error("Dashboard window was closed");
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

async function prepareDashboardSession(): Promise<void> {
	const ticket = await cli.createDashboardSession();
	const url = new URL("/desktop-auth", desktopWebUrl());
	url.hash = new URLSearchParams({ ticket }).toString();
	if (mainWindow) await mainWindow.loadURL(url.toString());
	else await createMainWindow(url.toString());
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
