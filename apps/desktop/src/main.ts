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

const APP_SCHEME = "clawdi-app";
const APP_HOST = "connect";
const DASHBOARD_ORIGIN = "https://cloud.clawdi.ai";
const DASHBOARD_PARTITION = "clawdi-dashboard";
const DASHBOARD_SIGN_IN_URL = `${DASHBOARD_ORIGIN}/sign-in`;
const CONNECT_URL = `${APP_SCHEME}://${APP_HOST}/renderer.html`;
const DASHBOARD_FAILURE_URL = `${CONNECT_URL}?surface=dashboard-failure`;
const DASHBOARD_LOAD_TIMEOUT_MS = 30_000;
const ERR_ABORTED = -3;
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
let dashboardFailureOpening: Promise<void> | null = null;
let dashboardSession: Session | null = null;
let dashboardAccountId: string | null = null;
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
	dashboardSession = session.fromPartition(DASHBOARD_PARTITION);
	registerAppProtocol(session.defaultSession);
	registerAppProtocol(dashboardSession);
	registerDashboardProtocol(dashboardSession);
	registerIpc();
	configurePermissions(dashboardSession);
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

function registerDashboardProtocol(targetSession: Session): void {
	const assets = readDashboardAssets();
	const index = assets.get("/index.html");
	if (!index) throw new Error("The packaged Dashboard is missing its SPA shell.");

	targetSession.protocol.handle("https", async (request) => {
		const url = new URL(request.url);
		if (url.origin !== DASHBOARD_ORIGIN) return forwardNetworkRequest(targetSession, request);
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}

		const asset = assets.get(url.pathname);
		if (asset) return localAssetResponse(asset, request.method);
		if (isDocumentRequest(request)) return localAssetResponse(index, request.method);
		return new Response(null, { status: 404 });
	});
}

function readDashboardAssets(): Map<string, string> {
	const raw: unknown = JSON.parse(
		readFileSync(join(app.getAppPath(), "dist", "web-assets.json"), "utf8"),
	);
	if (!Array.isArray(raw)) throw new Error("The packaged Dashboard asset manifest is invalid.");
	const root = join(app.getAppPath(), "dist", "web");
	const assets = new Map<string, string>();
	for (const entry of raw) {
		if (
			typeof entry !== "string" ||
			!entry ||
			entry.startsWith("/") ||
			entry.includes("\\") ||
			entry.split("/").some((part) => !part || part === "." || part === "..")
		) {
			throw new Error("The packaged Dashboard asset manifest is invalid.");
		}
		const pathname = new URL(entry, `${DASHBOARD_ORIGIN}/`).pathname;
		if (assets.has(pathname)) throw new Error("The packaged Dashboard has duplicate assets.");
		assets.set(pathname, join(root, ...entry.split("/")));
	}
	return assets;
}

async function localAssetResponse(path: string, method: string): Promise<Response> {
	const response = await net.fetch(pathToFileURL(path).toString());
	if (method !== "HEAD") return response;
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function forwardNetworkRequest(targetSession: Session, request: Request): Promise<Response> {
	return targetSession.fetch(request, { bypassCustomProtocolHandlers: true });
}

function isDocumentRequest(request: Request): boolean {
	return (
		request.destination === "document" ||
		(request.headers.get("accept") ?? "").includes("text/html")
	);
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
	ipcMain.handle(DESKTOP_IPC.signIn, (event) =>
		safeDashboardAction(event, "sign in", async () => {
			assertRuntimeLocation();
			const status = await cli.authenticate();
			if (status === "authenticated") {
				runAsync("open the signed-in dashboard", loadDashboardWithRecovery(true));
			}
			return { status };
		}),
	);
	ipcMain.handle(DESKTOP_IPC.signOut, (event) =>
		safeDashboardAction(event, "sign out", async () => {
			await cli.logout();
			await clearDashboardSession();
			setTrayState(trayState ? { ...trayState, auth: { authenticated: false, user: null } } : null);
			runAsync("refresh background sync status after sign out", refreshTrayState());
		}),
	);
	ipcMain.handle(DESKTOP_IPC.retryDashboard, (event) =>
		safeDashboardAction(event, "retry the dashboard", async () => {
			await loadDashboardWithRecovery(true);
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
	if (
		senderFrame.url !== DASHBOARD_FAILURE_URL &&
		urlOrigin(senderFrame.url) !== DASHBOARD_ORIGIN
	) {
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

function configurePermissions(targetSession: Session): void {
	session.defaultSession.setPermissionCheckHandler(() => false);
	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
		callback(false);
	});
	session.defaultSession.on("will-download", (event) => event.preventDefault());

	const allowDashboardClipboard = (
		webContents: Electron.WebContents | null,
		permission: string,
		requestingOrigin: string,
		embeddingOrigin: string,
	) =>
		permission === "clipboard-sanitized-write" &&
		webContents === mainWindow?.webContents &&
		urlOrigin(requestingOrigin) === DASHBOARD_ORIGIN &&
		urlOrigin(embeddingOrigin) === DASHBOARD_ORIGIN;
	targetSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
		allowDashboardClipboard(
			webContents,
			permission,
			requestingOrigin,
			details.embeddingOrigin ?? requestingOrigin,
		),
	);
	targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
		callback(
			allowDashboardClipboard(webContents, permission, details.requestingUrl, webContents.getURL()),
		);
	});
	targetSession.on("will-download", (event) => event.preventDefault());
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
			spellcheck: false,
		},
	});
	mainWindow = window;
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url === "about:blank") {
			return {
				action: "allow",
				overrideBrowserWindowOptions: {
					width: 1100,
					height: 760,
					webPreferences: {
						partition: DASHBOARD_PARTITION,
						contextIsolation: true,
						nodeIntegration: false,
						sandbox: true,
						spellcheck: false,
					},
				},
			};
		}
		if (isSafeExternalUrl(url)) runAsync("open the external link", shell.openExternal(url));
		return { action: "deny" };
	});
	window.webContents.on("did-create-window", (child) => hardenDashboardPopup(child));
	const preventUntrustedNavigation = (event: Electron.Event, url: string) => {
		if (url === DASHBOARD_FAILURE_URL || urlOrigin(url) === DASHBOARD_ORIGIN) return;
		event.preventDefault();
		if (isSafeExternalUrl(url)) runAsync("open the external link", shell.openExternal(url));
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
				window.isDestroyed() ||
				mainWindow !== window
			) {
				return;
			}
			console.error(`Dashboard failed to load: ${errorDescription} (${errorCode})`);
			runAsync("show the dashboard failure", showDashboardFailure());
		},
	);
	window.webContents.on("render-process-gone", (_event, details) => {
		if (quitting || window.isDestroyed() || mainWindow !== window) return;
		console.error(`Dashboard renderer exited: ${details.reason}`);
		runAsync("recover the dashboard renderer", showDashboardFailure(true));
	});
	window.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		window.hide();
	});
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});

	await loadWindowUrl(window, initialUrl);
}

function hardenDashboardPopup(window: BrowserWindow): void {
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	const preventUnsafeNavigation = (event: Electron.Event, url: string) => {
		if (url !== "about:blank" && !isSafeExternalUrl(url)) event.preventDefault();
	};
	window.webContents.on("will-navigate", preventUnsafeNavigation);
	window.webContents.on("will-redirect", preventUnsafeNavigation);
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
	await loadDashboardWithRecovery();
}

async function loadDashboardWithRecovery(forceAuthentication = false): Promise<void> {
	if (dashboardWindowOpening) return dashboardWindowOpening;
	const opening = (async () => {
		try {
			const state = await cli.bootstrapState();
			setTrayState(state);
			if (!state.auth.authenticated || !state.auth.user) {
				await clearDashboardSession();
				await showDashboardSignIn();
				return;
			}

			const window = mainWindow;
			const currentUrl = window && !window.isDestroyed() ? window.webContents.getURL() : "";
			if (
				window &&
				!window.isDestroyed() &&
				!forceAuthentication &&
				dashboardAccountId === state.auth.user.id &&
				isDashboardContentUrl(currentUrl)
			) {
				await presentMainWindow(window);
				return;
			}

			if (!(await prepareDashboardSession(state.auth.user.id, forceAuthentication))) {
				await clearDashboardSession();
				await showDashboardSignIn();
				return;
			}
			const readyWindow = mainWindow;
			if (!readyWindow || readyWindow.isDestroyed()) throw new Error("Dashboard window was closed");
			await presentMainWindow(readyWindow);
		} catch (error) {
			console.error("Could not open the dashboard", error);
			await showDashboardFailure();
		}
	})();
	dashboardWindowOpening = opening;
	try {
		await opening;
	} finally {
		if (dashboardWindowOpening === opening) dashboardWindowOpening = null;
	}
}

async function showDashboardSignIn(): Promise<void> {
	let window = mainWindow;
	if (!window || window.isDestroyed()) {
		await createMainWindow(DASHBOARD_SIGN_IN_URL);
		window = mainWindow;
	} else if (window.webContents.getURL() !== DASHBOARD_SIGN_IN_URL) {
		await loadWindowUrl(window, DASHBOARD_SIGN_IN_URL);
	}
	if (!window || window.isDestroyed()) throw new Error("Dashboard window was closed");
	await presentMainWindow(window);
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

async function prepareDashboardSession(
	accountId: string,
	forceAuthentication: boolean,
): Promise<boolean> {
	if (forceAuthentication || (dashboardAccountId && dashboardAccountId !== accountId)) {
		await clearDashboardSession();
	}
	let window = mainWindow;
	if (!window || window.isDestroyed()) {
		await createMainWindow(DASHBOARD_SIGN_IN_URL);
		window = mainWindow;
	}
	if (!window || window.isDestroyed()) throw new Error("Dashboard window was closed");

	const dashboardAuth = await cli.createDashboardSession();
	if (dashboardAuth.status === "reauth_required") return false;
	const url = new URL("/desktop-auth", DASHBOARD_ORIGIN);
	url.hash = new URLSearchParams({ ticket: dashboardAuth.ticket }).toString();
	const ready = waitForDashboardReady(window, DASHBOARD_LOAD_TIMEOUT_MS);
	try {
		await loadWindowUrl(window, url.toString());
		await ready;
	} catch (error) {
		void ready.catch(() => undefined);
		throw error;
	}
	dashboardAccountId = accountId;
	return true;
}

function waitForDashboardReady(window: BrowserWindow, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => finish(new Error("Dashboard sign-in timed out")), timeoutMs);
		const onNavigate = (_event: Electron.Event, url: string) => {
			if (isDashboardContentUrl(url)) finish();
		};
		const onDestroyed = () => finish(new Error("Dashboard window was closed"));
		window.webContents.on("did-navigate", onNavigate);
		window.webContents.once("destroyed", onDestroyed);

		function finish(error?: Error) {
			clearTimeout(timer);
			window.webContents.off("did-navigate", onNavigate);
			window.webContents.off("destroyed", onDestroyed);
			if (error) reject(error);
			else resolve();
		}
	});
}

async function clearDashboardSession(): Promise<void> {
	dashboardAccountId = null;
	if (dashboardSession) await dashboardSession.clearStorageData({ storages: ["cookies"] });
}

async function loadWindowUrl(window: BrowserWindow, url: string): Promise<void> {
	try {
		await window.loadURL(url);
	} catch (error) {
		if (!isExpectedDashboardRedirect(error, url)) throw error;
	}
}

function isExpectedDashboardRedirect(error: unknown, requestedUrl: string): boolean {
	if (urlOrigin(requestedUrl) !== DASHBOARD_ORIGIN || !isRecord(error)) return false;
	return (
		error.code === "ERR_ABORTED" &&
		error.errno === ERR_ABORTED &&
		typeof error.url === "string" &&
		urlOrigin(error.url) === DASHBOARD_ORIGIN
	);
}

function isDashboardContentUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return (
			url.origin === DASHBOARD_ORIGIN &&
			url.pathname !== "/desktop-auth" &&
			url.pathname !== "/sign-in"
		);
	} catch {
		return false;
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

function isSafeExternalUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && !url.username && !url.password;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
