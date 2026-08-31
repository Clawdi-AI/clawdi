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
	Tray,
} from "electron";
import { DESKTOP_IPC } from "./ipc";
import { DesktopCliError, DesktopCliService } from "./native-cli";

const APP_SCHEME = "clawdi-app";
const APP_HOST = "connect";
const CONNECT_URL = `${APP_SCHEME}://${APP_HOST}/renderer.html`;
const DASHBOARD_URL = `${CONNECT_URL}?surface=dashboard`;
const APP_ASSETS = new Map([
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
let dashboardWindowOpening: Promise<void> | null = null;
let quitting = false;

class DesktopConnectError extends Error {}

function runAsync(label: string, operation: Promise<unknown>): void {
	void operation.catch((error) => console.error(`Could not ${label}`, error));
}

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
	{
		scheme: APP_SCHEME,
		privileges: { standard: true, secure: true, supportFetchAPI: true },
	},
]);

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	const applicationStarted = app.whenReady().then(startApplication);
	app.on("window-all-closed", () => undefined);
	app.on("second-instance", () =>
		runAsync("show the existing window", applicationStarted.then(showAvailableWindow)),
	);
	void applicationStarted.catch((error) => {
		console.error("Could not start Clawdi", error);
		dialog.showErrorBox("Clawdi couldn't start", "Reinstall Clawdi and try again.");
		app.quit();
	});
}

async function startApplication(): Promise<void> {
	app.setName("Clawdi");
	const startHidden = wasOpenedAtLogin();
	if (startHidden && process.platform === "darwin") app.dock?.hide();
	registerAppProtocol(session.defaultSession);
	registerIpc();
	configurePermissions();
	createApplicationMenu();
	createTray();
	app.on("before-quit", () => {
		quitting = true;
		runAsync("cancel sign-in", cli.cancelAuthentication());
	});

	if (installationState().requiresMove) {
		setTrayState(null);
		if (!startHidden) await showConnectWindow();
	} else {
		if (startHidden) runAsync("refresh background sync status", refreshTrayState());
		else await openDashboard();
	}

	app.on("activate", () => runAsync("show the active window", showAvailableWindow()));
}

function registerAppProtocol(targetSession: Session): void {
	targetSession.protocol.handle(APP_SCHEME, (request) => {
		const url = new URL(request.url);
		const asset = url.host === APP_HOST ? APP_ASSETS.get(url.pathname) : null;
		if (request.method !== "GET" || !asset) return new Response(null, { status: 404 });
		return net.fetch(pathToFileURL(join(app.getAppPath(), "dist", asset)).toString());
	});
}

function registerIpc(): void {
	ipcMain.handle(DESKTOP_IPC.bootstrapState, (event) =>
		safeConnectAction(event, "prepare the local runtime", async () => {
			assertRuntimeLocation();
			const state = await cli.bootstrapState();
			setTrayState(state);
			return state;
		}),
	);
	ipcMain.handle(DESKTOP_IPC.installationState, (event) =>
		safeConnectAction(event, "check the app location", async () => installationState()),
	);
	ipcMain.handle(DESKTOP_IPC.detectAgents, (event) =>
		safeConnectAction(event, "inspect local Agents", () => {
			assertRuntimeLocation();
			return cli.detectAgents();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.authenticate, (event) =>
		safeConnectAction(event, "sign in", async () => {
			assertRuntimeLocation();
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
			runAsync("refresh background sync status", refreshTrayState());
			return result;
		}),
	);
	ipcMain.handle(DESKTOP_IPC.moveToApplicationsFolder, (event) =>
		safeConnectAction(event, "move Clawdi to Applications", async () => moveToApplicationsFolder()),
	);
	ipcMain.handle(DESKTOP_IPC.openDashboard, (event) =>
		safeConnectAction(event, "open the dashboard", async () => {
			assertRuntimeLocation();
			await openDashboard();
			connectWindow?.hide();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.dashboardState, (event) =>
		safeDashboardAction(event, "read local dashboard data", async () => {
			const state = await cli.dashboardState();
			setTrayState(state);
			return state;
		}),
	);
	ipcMain.handle(DESKTOP_IPC.readLocalSession, (event, agent: unknown, sessionId: unknown) =>
		safeDashboardAction(event, "read the local session", () => {
			if (
				!isDesktopAgentType(agent) ||
				typeof sessionId !== "string" ||
				!sessionId.trim() ||
				sessionId.length > 4096
			) {
				throw new Error("Invalid local session request.");
			}
			return cli.readLocalSession(agent, sessionId);
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
	if (senderFrame.url !== DASHBOARD_URL) {
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
	if (senderUrl !== CONNECT_URL) {
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
	session.defaultSession.on("will-download", (event) => event.preventDefault());
}

function hardenLocalWindow(window: BrowserWindow, allowedUrl: string, label: string): void {
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	const preventUnexpectedNavigation = (event: Electron.Event, url: string) => {
		if (url !== allowedUrl) event.preventDefault();
	};
	window.webContents.on("will-navigate", preventUnexpectedNavigation);
	window.webContents.on("will-redirect", preventUnexpectedNavigation);
	window.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
			if (quitting || !isMainFrame || window.isDestroyed()) return;
			console.error(`${label} failed to load: ${errorDescription} (${errorCode})`);
		},
	);
	window.webContents.on("render-process-gone", (_event, details) => {
		if (quitting || window.isDestroyed()) return;
		console.error(`${label} renderer exited: ${details.reason}`);
		window.webContents.reload();
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
			{ role: "close" },
			{ role: "minimize" },
			{ role: "zoom" },
			...(process.platform === "darwin"
				? ([{ type: "separator" }, { role: "front" }] satisfies MenuItemConstructorOptions[])
				: []),
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

async function createMainWindow(): Promise<void> {
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
			spellcheck: false,
		},
	});
	mainWindow = window;
	hardenLocalWindow(window, DASHBOARD_URL, "Dashboard");
	window.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		window.hide();
	});
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});

	await window.loadURL(DASHBOARD_URL);
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
			spellcheck: false,
		},
	});
	connectWindow = window;
	hardenLocalWindow(window, CONNECT_URL, "Connect Agent");
	window.once("ready-to-show", () => window.show());
	window.on("closed", () => {
		runAsync("cancel sign-in", cli.cancelAuthentication());
		if (connectWindow === window) connectWindow = null;
	});
	await window.loadURL(CONNECT_URL);
}

function createTray(): void {
	const icon = desktopIcon();
	if (icon.isEmpty()) return;
	const trayIcon = icon.resize({ width: 18, height: 18 });
	if (process.platform === "darwin") trayIcon.setTemplateImage(true);
	tray = new Tray(trayIcon);
	tray.setToolTip("Clawdi");
	renderTrayMenu();
	tray.on("click", () => runAsync("show Clawdi", showAvailableWindow()));
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
				runAsync(
					"repair background sync",
					trayState?.daemon.installed ? restartBackgroundSync() : showConnectWindow(),
				),
		},
		{
			label: "Refresh Status",
			click: () => runAsync("refresh background sync status", refreshTrayState()),
		},
		{ type: "separator" },
		{
			label: "Open Clawdi",
			click: () => runAsync("show Clawdi", showAvailableWindow()),
		},
		{
			label: "Connect Agent…",
			click: () => runAsync("open Connect Agent", showConnectWindow()),
		},
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
				click: (item) => runAsync("change the login item", setLaunchAtLogin(item.checked)),
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
	if (installationState().requiresMove) {
		setTrayState(null);
		return;
	}
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
		setTimeout(() => runAsync("refresh background sync status", refreshTrayState()), 2_000).unref();
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

function assertRuntimeLocation(): void {
	if (!installationState().requiresMove) return;
	throw new DesktopConnectError("Move Clawdi to Applications before starting its local runtime.");
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
	if (installationState().requiresMove) {
		await showConnectWindow();
		return;
	}
	await openDashboard();
}

async function showMainWindow(): Promise<void> {
	const window = mainWindow;
	if (!window || window.isDestroyed()) {
		await openDashboard();
		return;
	}
	await presentMainWindow(window);
}

async function openDashboard(): Promise<void> {
	if (dashboardWindowOpening) return dashboardWindowOpening;
	const opening = (async () => {
		if (!mainWindow || mainWindow.isDestroyed()) await createMainWindow();
		const window = mainWindow;
		if (!window || window.isDestroyed()) throw new Error("Dashboard window was closed");
		await presentMainWindow(window);
	})();
	dashboardWindowOpening = opening;
	try {
		await opening;
	} finally {
		if (dashboardWindowOpening === opening) dashboardWindowOpening = null;
	}
}

async function presentMainWindow(window: BrowserWindow): Promise<void> {
	if (process.platform === "darwin") await app.dock?.show();
	if (window.isDestroyed()) throw new Error("Dashboard window was closed");
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

function desktopIcon() {
	const path = app.isPackaged
		? join(process.resourcesPath, "clawdi-logo.png")
		: join(app.getAppPath(), "..", "web", "public", "clawdi-logo-transparent.png");
	return nativeImage.createFromPath(path);
}
