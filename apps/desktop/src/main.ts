import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	DesktopAgentConnection,
	DesktopAgentType,
	DesktopAuthenticationResult,
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
	type MessageBoxOptions,
	Notification,
	nativeImage,
	net,
	powerMonitor,
	protocol,
	type Session,
	session,
	shell,
	Tray,
} from "electron";
import electronUpdater from "electron-updater";
import {
	authenticateDesktopAccount,
	prepareDesktopStartup,
	reconcileDesktopStartupSync,
} from "./auth-orchestrator";
import { type DesktopCliCommandOptions, installDesktopCliCommand } from "./cli-command";
import { openDashboardInBrowser } from "./dashboard-browser";
import { DESKTOP_IPC } from "./ipc";
import { getDesktopLogDirectory, initializeDesktopLogging } from "./logging";
import {
	readDesktopLoginItemSettings,
	setDesktopLaunchAtLogin,
	supportsDesktopLoginItems,
	wasDesktopOpenedAtLogin,
} from "./login-item";
import { DesktopCliError, DesktopCliService } from "./native-cli";
import { requireDesktopPlatform } from "./platform";
import { DesktopUpdateController } from "./update-controller";
import { DesktopUpdateInstallation } from "./update-install";
import { desktopUpdateDownloadUrl, desktopUpdateNotification } from "./update-notification";
import { evaluateDesktopUpdatePolicy } from "./update-policy";
import { readMacCodeSignature } from "./update-signature";
import { type DesktopUpdateState, desktopUpdateStatusLabel } from "./update-state";

const APP_SCHEME = "clawdi-app";
const APP_HOST = "connect";
const CONNECT_URL = `${APP_SCHEME}://${APP_HOST}/renderer.html`;
const APP_ASSETS = new Map([
	["/renderer.html", "renderer.html"],
	["/connect-renderer.js", "connect-renderer.js"],
	["/connect-renderer.css", "connect-renderer.css"],
	["/clawdi-logo.png", "clawdi-logo.png"],
]);
const cli = new DesktopCliService(app);
let connectWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayState: DesktopBootstrapState | null = null;
let trayStateChecking = true;
let trayStateRefresh: Promise<void> | null = null;
let availableWindowOpening: Promise<void> | null = null;
let updateController: DesktopUpdateController | null = null;
let updateInstallation: DesktopUpdateInstallation | null = null;
let updateNotification: Notification | null = null;
let updateState: DesktopUpdateState = { status: "disabled", reason: "development" };
let updatePromptedVersion: string | null = null;
let activeCriticalOperations = 0;
let quitting = false;

class DesktopConnectError extends Error {}
function runAsync(label: string, operation: Promise<unknown>): void {
	void operation.catch((error) => console.error(`Could not ${label}`, error));
}

function activeDialogParent(preferred?: BrowserWindow | null): BrowserWindow | null {
	if (preferred && !preferred.isDestroyed()) return preferred;
	return (
		[connectWindow].find((window) => window && !window.isDestroyed() && window.isVisible()) ?? null
	);
}

function showMessageBox(
	options: MessageBoxOptions,
	preferred?: BrowserWindow | null,
): ReturnType<typeof dialog.showMessageBox> {
	const parent = activeDialogParent(preferred);
	return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

function showMessageBoxSync(options: MessageBoxOptions, preferred?: BrowserWindow | null): number {
	const parent = activeDialogParent(preferred);
	return parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options);
}

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
	{
		scheme: APP_SCHEME,
		privileges: { standard: true, secure: true, supportFetchAPI: true },
	},
]);

if (process.platform === "win32") app.setAppUserModelId("ai.clawdi.desktop");

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
	// https://www.electronjs.org/docs/latest/api/app#appsetapplogspathpath
	app.setAppLogsPath();
	try {
		initializeDesktopLogging(getDesktopLogDirectory(app));
	} catch {
		console.error("Desktop file logging unavailable; using console output.");
	}
	console.info("Desktop starting", { platform: process.platform, version: app.getVersion() });
	const startHidden = wasOpenedAtLogin();
	if (startHidden && process.platform === "darwin") app.dock?.hide();
	registerAppProtocol(session.defaultSession);
	registerIpc();
	configurePermissions();
	createApplicationMenu();
	createTray();
	app.on("before-quit", (event) => {
		if (updateInstallation?.shouldDeferQuit()) {
			event.preventDefault();
			runAsync("install the update on quit", updateInstallation.install(true));
			return;
		}
		quitting = true;
		updateController?.stop();
		runAsync("cancel sign-in", cli.cancelAuthentication());
	});

	if (installationState().requiresMove) {
		setTrayState(null);
		if (!startHidden) await showConnectWindow();
	} else {
		const startup = await prepareDesktopStartup(cli);
		setTrayState(startup.state);
		if (!startHidden) {
			if (startup.requiresWizard) await showConnectWindow();
			else await openDashboard();
		}
		if (!startup.requiresWizard) {
			runAsync("reconcile sync after startup", reconcileBackgroundSyncAfterStartup());
		}
		setImmediate(() =>
			runAsync(
				"reconcile the CLI command",
				reconcileDesktopCliCommand(startup.state.daemon.installed),
			),
		);
	}
	runAsync("initialize Desktop updates", initializeUpdates());

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

async function initializeUpdates(): Promise<void> {
	const channel = readPackageMetadataField("clawdiUpdateChannel");
	const shouldInspectSignature =
		app.isPackaged &&
		process.platform === "darwin" &&
		process.mas !== true &&
		(channel === "stable" || channel === "beta");
	const signature = shouldInspectSignature ? await readMacCodeSignature(process.execPath) : null;
	const policy = evaluateDesktopUpdatePolicy({
		isPackaged: app.isPackaged,
		platform: process.platform,
		isMacAppStore: process.mas === true,
		channel,
		signature,
		isAppImage: Boolean(process.env.APPIMAGE),
	});
	if (!("channel" in policy)) {
		console.info(`Desktop updates disabled: ${policy.reason}`);
		updateState = { status: "disabled", reason: policy.reason };
		renderUpdateMenus();
		return;
	}
	// A Linux updater checks the same generic feed for DEB/RPM. AppImageUpdater
	// requires APPIMAGE even to check; DebUpdater can check installed packages.
	// autoDownload=false and the policy prohibit all artifact/installer operations.
	// https://www.electron.build/docs/features/auto-update/
	const updater = policy.enabled ? electronUpdater.autoUpdater : new electronUpdater.DebUpdater();
	updater.logger = console;
	updateController = new DesktopUpdateController({
		policy,
		updater,
		onStateChange: (state) => {
			console.info("Desktop update state", state.status);
			updateState = state;
			renderUpdateMenus();
		},
		onUpdateReady: (version) => {
			showUpdateNotification(version, true);
			runAsync("offer the downloaded update", maybePromptForUpdate());
		},
		onUpdateAvailable: (version) => showUpdateNotification(version, false),
	});
	updateInstallation = new DesktopUpdateInstallation({
		platform: process.platform,
		isReady: () => updateState.status === "ready",
		isBusy: () => activeCriticalOperations > 0,
		stopBackgroundServices: () =>
			withCriticalOperation(async () => {
				const state = await cli.bootstrapState();
				// Release executable locks. Retain the installed unit as durable Sync intent.
				if (state.daemon.installed) await cli.stopDaemon();
				return state.daemon.installed;
			}),
		restoreBackgroundServices: () => cli.restartDaemon(),
		install: (onQuit) => {
			if (onQuit) {
				app.quit(); // electron-updater autoInstallOnAppQuit; no relaunch.
				return true;
			}
			return updateController?.installDownloadedUpdate() ?? false;
		},
	});
	updateController.start();
	powerMonitor.on("resume", () =>
		runAsync(
			"check for updates after resume",
			updateController?.checkForUpdates() ?? Promise.resolve(),
		),
	);
}

function showUpdateNotification(version: string, ready: boolean): void {
	// https://www.electronjs.org/docs/latest/api/notification
	if (!Notification.isSupported()) return;
	try {
		updateNotification?.close();
		updateNotification = new Notification({
			...desktopUpdateNotification(version, ready),
			icon: desktopIcon(),
		});
		updateNotification.once("click", () => {
			if (ready) restartToInstallUpdate();
			else
				runAsync(
					"open the Desktop download",
					shell.openExternal(desktopUpdateDownloadUrl(version)),
				);
		});
		updateNotification.on("failed", (_event, error) =>
			console.error("Could not show the Desktop update notification", error),
		);
		updateNotification.show();
	} catch (error) {
		console.error("Could not show the Desktop update notification", error);
	}
}

function readPackageMetadataField(name: string): unknown {
	try {
		const metadata: unknown = JSON.parse(
			readFileSync(join(app.getAppPath(), "package.json"), "utf8"),
		);
		return isRecord(metadata) ? metadata[name] : undefined;
	} catch (error) {
		console.error("Could not read Desktop package metadata", error);
		return undefined;
	}
}

function renderUpdateMenus(): void {
	if (!app.isReady()) return;
	createApplicationMenu();
	renderTrayMenu();
}

function updateMenuItems(): MenuItemConstructorOptions[] {
	const items = updateActionMenuItems();
	return items.length > 0 ? [{ type: "separator" }, ...items] : [];
}

function updateActionMenuItems(): MenuItemConstructorOptions[] {
	if (updateState.status === "disabled") return [];
	const status = desktopUpdateStatusLabel(updateState);
	const items: MenuItemConstructorOptions[] = status ? [{ label: status, enabled: false }] : [];
	if (updateState.status === "ready") {
		items.push({
			label: "Restart to Install Update",
			enabled: activeCriticalOperations === 0 && !updateInstallation?.isInProgress,
			click: restartToInstallUpdate,
		});
	} else if (updateState.status === "available") {
		const version = updateState.version;
		items.push({
			label: "Download New Version…",
			click: () =>
				runAsync(
					"open the Desktop download",
					shell.openExternal(desktopUpdateDownloadUrl(version)),
				),
		});
	}
	if (
		updateState.status === "idle" ||
		updateState.status === "error" ||
		updateState.status === "available"
	) {
		items.push({
			label: "Check for Updates…",
			click: () => runAsync("check for updates", checkForUpdatesManually()),
		});
	}
	return items;
}

async function checkForUpdatesManually(): Promise<void> {
	if (!updateController || updateState.status === "disabled") return;
	await updateController.checkForUpdates();
	if (updateState.status === "idle") {
		await showMessageBox({
			type: "info",
			message: "Clawdi is up to date",
			detail: `You are running Clawdi ${app.getVersion()}.`,
		});
	} else if (updateState.status === "error") {
		await showMessageBox({
			type: "warning",
			message: "Clawdi couldn't check for updates",
			detail: "Check your connection and try again later.",
		});
	}
}

async function maybePromptForUpdate(): Promise<void> {
	if (
		updateState.status !== "ready" ||
		updateInstallation?.isInProgress ||
		activeCriticalOperations > 0 ||
		updatePromptedVersion === updateState.version
	) {
		return;
	}
	const parent = [connectWindow].find(
		(window) => window && !window.isDestroyed() && window.isVisible(),
	);
	if (!parent) return;
	updatePromptedVersion = updateState.version;
	const choice = await showMessageBox(
		{
			type: "info",
			message: `Clawdi ${updateState.version} is ready`,
			detail:
				"Choose Later to keep working, then use Restart to Install Update from the Clawdi menu.",
			buttons: ["Restart and Install", "Later"],
			defaultId: 0,
			cancelId: 1,
			noLink: true,
		},
		parent,
	);
	if (choice.response === 0) restartToInstallUpdate();
}

function restartToInstallUpdate(): void {
	if (updateInstallation) runAsync("prepare the update", updateInstallation.install(false));
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
		safeConnectAction(event, "inspect local agents", () => {
			assertRuntimeLocation();
			return cli.detectAgents();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.listReconnectableAgents, (event) =>
		safeConnectAction(event, "find reconnectable agents", () => {
			assertRuntimeLocation();
			return cli.listReconnectableAgents();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.authenticate, (event) =>
		safeConnectAction(event, "sign in", async () => {
			assertRuntimeLocation();
			const result = await authenticateAccount();
			console.info("Desktop sign-in result", result.status);
			if (result.status === "cancelled") {
				return { status: "cancelled" as const };
			}
			setTrayState(result.state);
			return result;
		}),
	);
	ipcMain.handle(DESKTOP_IPC.cancelAuthentication, (event) =>
		safeConnectAction(event, "cancel sign-in", async () => ({
			status: await cli.cancelAuthentication(),
		})),
	);
	ipcMain.handle(DESKTOP_IPC.connectAgents, (event, rawConnections: unknown) =>
		safeConnectAction(event, "connect the selected agents", async () => {
			assertSafeDaemonMutation();
			const result = await withCriticalOperation(() =>
				cli.connectAgents(readAgentConnections(rawConnections)),
			);
			runAsync("refresh sync status", refreshTrayState());
			return result;
		}),
	);
	ipcMain.handle(DESKTOP_IPC.moveToApplicationsFolder, (event) =>
		safeConnectAction(event, "move Clawdi to Applications", async () => moveToApplicationsFolder()),
	);
	ipcMain.handle(DESKTOP_IPC.openDashboard, (event) =>
		safeConnectAction(event, "open the dashboard", async () => {
			assertRuntimeLocation();
			const window = connectWindow;
			await openDashboard();
			runAsync("reconcile sync after opening Dashboard", reconcileBackgroundSyncAfterStartup());
			if (window && !window.isDestroyed()) window.destroy();
		}),
	);
}

async function authenticateAccount(): Promise<DesktopAuthenticationResult> {
	return authenticateDesktopAccount({
		bootstrapState: () => cli.bootstrapState(),
		authenticate: () =>
			cli.authenticate((progress) => {
				if (connectWindow && !connectWindow.isDestroyed())
					connectWindow.webContents.send(DESKTOP_IPC.authenticationProgress, progress);
			}),
	});
}

async function withCriticalOperation<T>(action: () => Promise<T>): Promise<T> {
	activeCriticalOperations += 1;
	renderUpdateMenus();
	try {
		return await action();
	} finally {
		activeCriticalOperations -= 1;
		renderUpdateMenus();
		if (activeCriticalOperations === 0) {
			if (updateInstallation)
				runAsync("finish the requested quit", updateInstallation.resumePendingQuit());
			runAsync("offer the downloaded update", maybePromptForUpdate());
		}
	}
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
		throw new Error(`Couldn't ${label}. Try again.`);
	}
}

function assertConnectSender(event: IpcMainInvokeEvent): void {
	if (event.sender !== connectWindow?.webContents)
		throw new Error("Unexpected Connect an Agent client.");
	const senderFrame = event.senderFrame;
	if (!senderFrame || senderFrame !== event.sender.mainFrame)
		throw new Error("Unexpected Connect an Agent frame.");
	const senderUrl = senderFrame.url;
	if (senderUrl !== CONNECT_URL) {
		throw new Error("Unexpected Connect an Agent URL.");
	}
}

function readAgentConnections(value: unknown): DesktopAgentConnection[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("Choose at least one supported agent.");
	}
	const connections: DesktopAgentConnection[] = [];
	const types = new Set<DesktopAgentType>();
	for (const item of value) {
		if (!isRecord(item) || !isDesktopAgentType(item.type) || types.has(item.type)) {
			throw new Error("Choose each supported agent once.");
		}
		const reconnectAgentId = item.reconnectAgentId;
		const confirmTakeover = item.confirmTakeover;
		if (
			reconnectAgentId !== undefined &&
			(typeof reconnectAgentId !== "string" ||
				!reconnectAgentId.trim() ||
				reconnectAgentId.length > 256)
		) {
			throw new Error("Choose a valid agent to reconnect.");
		}
		if (confirmTakeover !== undefined && typeof confirmTakeover !== "boolean") {
			throw new Error("Choose a valid agent takeover confirmation.");
		}
		if (confirmTakeover === true && typeof reconnectAgentId !== "string") {
			throw new Error("Agent takeover confirmation requires a reconnect target.");
		}
		types.add(item.type);
		connections.push({
			type: item.type,
			...(typeof reconnectAgentId === "string"
				? { reconnectAgentId: reconnectAgentId.trim() }
				: {}),
			...(confirmTakeover === true ? { confirmTakeover: true } : {}),
		});
	}
	return connections;
}

function configurePermissions(): void {
	session.defaultSession.setPermissionCheckHandler(() => false);
	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
		callback(false),
	);
	session.defaultSession.on("will-download", (event) => event.preventDefault());
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
	const viewMenu: MenuItemConstructorOptions = {
		label: "View",
		submenu: [
			{
				label: "Open Dashboard in Browser",
				accelerator: "CmdOrCtrl+R",
				click: () => runAsync("open Dashboard", openDashboard()),
			},
			{ type: "separator" },
			{ role: "resetZoom" },
			{ role: "zoomIn" },
			{ role: "zoomOut" },
			{ type: "separator" },
			{ role: "togglefullscreen" },
		],
	};
	const template: MenuItemConstructorOptions[] = [editMenu, viewMenu, windowMenu];
	if (process.platform === "darwin") {
		template.unshift({
			label: app.name,
			submenu: [
				{ role: "about" },
				...updateMenuItems(),
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit", enabled: activeCriticalOperations === 0 },
			],
		});
	}
	if (process.platform !== "darwin")
		template.unshift({
			label: "File",
			submenu: [
				...updateActionMenuItems(),
				{ role: "quit", enabled: activeCriticalOperations === 0 },
			],
		});
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function reconcileDesktopCliCommand(daemonInstalled: boolean): Promise<void> {
	if (!app.isPackaged) return;
	const result = await installDesktopCliCommand(
		desktopCliCommandOptions(await cli.shellCommandTarget()),
	);
	if (!daemonInstalled) await cli.pruneUnusedAppImageRuntimes();
	if (result.status === "installed" && !result.pathReady) {
		console.warn(`The clawdi command is installed outside PATH: ${result.path}`);
	}
}

function desktopCliCommandOptions(target: string): DesktopCliCommandOptions {
	return {
		platform: requireDesktopPlatform(),
		target,
		home: app.getPath("home"),
		userData: app.getPath("userData"),
		localAppData: process.env.LOCALAPPDATA,
		environmentPath: process.env.PATH,
		windowsPathScript: join(process.resourcesPath, "support", "windows-cli-path.ps1"),
	};
}

function hardenLocalWindow(
	window: BrowserWindow,
	allowedUrl: string,
	label: string,
	maxRendererReloads = 0,
): void {
	let rendererReloads = 0;
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
		if (rendererReloads < maxRendererReloads) {
			rendererReloads += 1;
			window.webContents.reload();
			return;
		}
		runAsync(
			`report the ${label} renderer failure`,
			showMessageBox(
				{
					type: "warning",
					message: `${label} couldn't recover`,
					detail: "Close this window and open it again from Clawdi.",
				},
				window,
			),
		);
	});
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
		title: "Connect an Agent",
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
	hardenLocalWindow(window, CONNECT_URL, "Connect an Agent", 1);
	window.once("ready-to-show", () => window.show());
	window.on("closed", () => {
		runAsync("cancel sign-in", cli.cancelAuthentication());
		if (connectWindow === window) connectWindow = null;
	});
	await window.loadURL(CONNECT_URL);
}

function createTray(): void {
	const trayIcon =
		process.platform === "darwin"
			? nativeImage.createFromPath(join(app.getAppPath(), "dist", "trayTemplate.png"))
			: nativeImage.createFromPath(
					join(
						app.getAppPath(),
						"dist",
						process.platform === "win32" ? "trayWindows.png" : "trayLinux.png",
					),
				);
	if (trayIcon.isEmpty()) throw new Error("Tray icon is missing.");
	if (process.platform === "darwin") trayIcon.setTemplateImage(true);
	tray = new Tray(trayIcon);
	tray.setToolTip("Clawdi");
	renderTrayMenu();
	const statusRefresh = setInterval(() => {
		if (!quitting && activeCriticalOperations === 0) {
			runAsync("refresh sync status", refreshTrayState());
		}
	}, 60_000);
	statusRefresh.unref();
	app.once("before-quit", () => clearInterval(statusRefresh));
	if (process.platform !== "darwin") {
		tray.on("click", () => runAsync("show Clawdi", showAvailableWindow()));
	}
}

function renderTrayMenu(): void {
	if (!tray) return;
	tray.setToolTip(`Clawdi · ${trayStatus()}`);
	const template: MenuItemConstructorOptions[] = [
		{ label: trayStatus(), enabled: false },
		{
			type: "checkbox",
			label: "Sync",
			checked: trayState?.daemon.installed === true,
			enabled: trayState !== null && !trayStateChecking && activeCriticalOperations === 0,
			click: (item) => runAsync("change sync", setSyncEnabled(item.checked)),
		},
		{ type: "separator" },
		{
			label: "Open Dashboard",
			click: () => runAsync("open Dashboard", openDashboard()),
		},
		{
			label: "Connect an Agent…",
			click: () => runAsync("open Connect an Agent", showConnectWindow()),
		},
		{
			label: "Sign Out of Desktop",
			enabled: trayState?.auth.authenticated === true && activeCriticalOperations === 0,
			click: () => runAsync("sign out of Desktop", signOutOfDesktop()),
		},
	];
	template.push(...updateMenuItems());

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
			enabled: activeCriticalOperations === 0,
			click: () => {
				app.quit();
			},
		},
	);
	tray.setContextMenu(Menu.buildFromTemplate(template));
}

function trayStatus(): string {
	if (trayStateChecking) return "Sync: Checking…";
	if (!trayState) return "Sync: Unavailable";
	if (!trayState.auth.authenticated) return "Sync: Sign In Required";
	if (!trayState.daemon.installed) return "Sync: Off";
	return trayState.daemon.running ? "Sync: Running" : "Sync: Needs Attention";
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
			console.error("Could not refresh sync status", error);
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

async function setSyncEnabled(enabled: boolean): Promise<void> {
	if (!enabled) return turnOffBackgroundSync();
	try {
		await withCriticalOperation(async () => {
			assertSafeDaemonMutation();
			const state = await cli.bootstrapState();
			if (!state.auth.authenticated) {
				await showConnectWindow();
				return;
			}
			const agents = await cli.detectAgents();
			if (!agents.some((agent) => agent.registered && agent.inspection === "complete")) {
				await showConnectWindow();
				return;
			}
			await cli.installDaemon();
		});
	} catch (error) {
		console.error("Could not enable sync", error);
		await showMessageBox({
			type: "warning",
			message: "Sync couldn't be enabled",
			detail: "Open Connect an Agent to check the local setup.",
		});
	} finally {
		await refreshTrayState();
	}
}

async function turnOffBackgroundSync(): Promise<void> {
	trayStateChecking = true;
	renderTrayMenu();
	try {
		await withCriticalOperation(() => cli.uninstallDaemon());
		await refreshTrayState();
	} catch (error) {
		console.error("Could not turn off sync", error);
		await refreshTrayState();
		await showMessageBox({
			type: "warning",
			message: "Sync couldn't be turned off",
			detail: "Try again, or open Connect an Agent to inspect the local setup.",
		});
	}
}

async function setLaunchAtLogin(enabled: boolean): Promise<void> {
	if (!supportsDesktopLoginItems() || !app.isPackaged) {
		renderTrayMenu();
		return;
	}
	if (enabled && installationState().requiresMove) {
		renderTrayMenu();
		await promptToMove("Clawdi must be in Applications before it can open at login.");
		return;
	}
	try {
		setDesktopLaunchAtLogin(app, enabled);
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
	if (!supportsDesktopLoginItems() || !app.isPackaged) return null;
	try {
		return readDesktopLoginItemSettings(app);
	} catch (error) {
		console.error("Could not read the login item", error);
		return null;
	}
}

function wasOpenedAtLogin(): boolean {
	try {
		return wasDesktopOpenedAtLogin(app);
	} catch (error) {
		console.error("Could not read the login launch state", error);
		return false;
	}
}

async function showLoginItemError(): Promise<void> {
	await showMessageBox({
		type: "warning",
		message: "The login item couldn't be changed",
		detail:
			process.platform === "win32"
				? "Review Clawdi in Settings > Apps > Startup and try again."
				: "Review Clawdi in System Settings > General > Login Items and try again.",
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
		"Move Clawdi to Applications before connecting agents or repairing sync.",
	);
}

function moveToApplicationsFolder(): DesktopMoveToApplicationsResult {
	if (!installationState().requiresMove) return { status: "not-required" };
	const moved = app.moveToApplicationsFolder({
		conflictHandler: (conflictType) => {
			const running = conflictType === "existsAndRunning";
			return (
				showMessageBoxSync({
					type: "question",
					message: running
						? "Clawdi is already running from Applications"
						: "Replace the existing Clawdi app?",
					detail: running
						? "Open the installed copy and close this one. Sync remains independent."
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
	const choice = await showMessageBox({
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
		await showMessageBox({
			type: "warning",
			message: "Clawdi couldn't be moved",
			detail: "Move Clawdi to Applications in Finder, reopen it, and try again.",
		});
	}
}

async function showAvailableWindow(): Promise<void> {
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
	const startup = await prepareDesktopStartup(cli);
	setTrayState(startup.state);
	if (startup.requiresWizard) {
		await showConnectWindow();
		return;
	}
	await openDashboard();
	runAsync("reconcile sync after opening Clawdi", reconcileBackgroundSyncAfterStartup());
}

async function reconcileBackgroundSyncAfterStartup(): Promise<void> {
	const recovery = await reconcileDesktopStartupSync(cli);
	setTrayState(recovery.state);
}

async function openDashboard(): Promise<void> {
	await openDashboardInBrowser(
		(url) => shell.openExternal(url),
		process.env.CLAWDI_DESKTOP_WEB_URL,
	);
}

async function signOutOfDesktop(): Promise<void> {
	await withCriticalOperation(async () => {
		await cli.cancelAuthentication();
		await cli.logout();
	});
	setTrayState(
		trayState
			? {
					...trayState,
					auth: { authenticated: false, user: null },
					daemon: { installed: false, running: false },
				}
			: null,
	);
	if (connectWindow && !connectWindow.isDestroyed()) connectWindow.webContents.reload();
	await showConnectWindow();
	await showMessageBox({
		type: "info",
		message: "Signed out of Clawdi Desktop",
		detail:
			"Sync is off. Your browser stays signed in; sign out of the dashboard in your browser separately.",
	});
}

function desktopIcon() {
	const path = app.isPackaged
		? join(process.resourcesPath, "clawdi-logo.png")
		: join(app.getAppPath(), "..", "web", "public", "clawdi-logo-transparent.png");
	return nativeImage.createFromPath(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
