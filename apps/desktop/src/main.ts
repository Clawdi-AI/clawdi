import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	DesktopAgentConnection,
	DesktopAgentType,
	DesktopAuthenticationResult,
	DesktopBootstrapState,
	DesktopConnectView,
	DesktopExcludedProjectAddResult,
	DesktopInstallationState,
	DesktopMoveToApplicationsResult,
} from "@clawdi/shared/desktop";
import { DESKTOP_DEEP_LINK_SCHEME, isDesktopAgentType } from "@clawdi/shared/desktop";
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
	nativeTheme,
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
import {
	assertConnectSender,
	readExcludedProjectRemoval,
	verificationPageToOpen,
} from "./connect-ipc";
import {
	allowsDashboardNavigation,
	allowsDashboardPermission,
	assertDashboardSender,
	DASHBOARD_PARTITION,
	dashboardAuthRedirect,
	dashboardClerkOrigins,
	dashboardOrigin,
	dashboardSessionIds,
	dashboardWindowOptions,
	readDesktopWebSession,
	strictHttpsUrl,
} from "./dashboard-window";
import { connectViewFromArgv, connectViewFromDeepLink } from "./deep-link";

import {
	applicationMenuTemplate,
	type DesktopMenuActions,
	type DesktopMenuState,
	type DesktopSyncStatus,
	desktopSyncStatusLabel,
	trayMenuTemplate,
} from "./desktop-menus";
import { claimFirstConnection } from "./first-connection";
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
// Geist files copied by scripts/build.ts; the pattern admits no path separators.
const APP_FONT = /^\/files\/(geist-(?:sans|mono)-latin-\d{3}-normal\.woff2?)$/;
const DOCS_URL = "https://docs.clawdi.ai";
const SUPPORT_URL = "mailto:support@clawdi.ai";
// --background from packages/shared/src/style/theme.css, shown before the renderer paints.
const WINDOW_BACKGROUND = { light: "#fafaf8", dark: "#11100f" } as const;
const WEB_ORIGIN = dashboardOrigin(process.env.CLAWDI_DESKTOP_WEB_URL);
const CLERK_ORIGINS = dashboardClerkOrigins(process.env.CLAWDI_DESKTOP_CLERK_ORIGINS);
const cli = new DesktopCliService(app);
let connectWindow: BrowserWindow | null = null;
let dashboardWindow: BrowserWindow | null = null;
let dashboardOpening: Promise<void> | null = null;
let dashboardAccountId: string | null = null;
let signingOut = false;
// Cleared only when the renderer takes it, so a request survives window creation.
let requestedConnectView: DesktopConnectView | null = null;
// A clawdi-desktop:// link that launched the app: argv on Windows and Linux,
// open-url before ready on macOS.
let launchConnectView = connectViewFromArgv(process.argv);
let verificationPage: string | null = null;
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
		[dashboardWindow, connectWindow].find(
			(window) => window && !window.isDestroyed() && window.isVisible(),
		) ?? null
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
	// Registered before ready so macOS delivers the link that launched the app.
	// https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app
	app.on("open-url", (event, url) => {
		event.preventDefault();
		const view = connectViewFromDeepLink(url);
		if (!view) {
			console.warn("Ignored an unsupported Clawdi Desktop link");
		} else if (!app.isReady()) {
			launchConnectView = view;
		} else {
			runAsync(
				"open Connect from a link",
				applicationStarted.then(() => showAvailableWindow(view)),
			);
		}
	});
	app.on("window-all-closed", () => undefined);
	app.on("second-instance", (_event, argv) =>
		runAsync(
			"show the existing window",
			applicationStarted.then(() => showAvailableWindow(connectViewFromArgv(argv) ?? undefined)),
		),
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
	let logDirectory: string | undefined;
	try {
		app.setAppLogsPath();
		logDirectory = getDesktopLogDirectory(app);
	} catch {
		// Logging still redacts console output if Electron cannot create its directory.
	}
	initializeDesktopLogging(logDirectory);
	console.info("Desktop starting", { platform: process.platform, version: app.getVersion() });
	registerDeepLinkProtocol();
	const startHidden = !launchConnectView && wasOpenedAtLogin();
	if (startHidden && process.platform === "darwin") app.dock?.hide();
	registerAppProtocol(session.defaultSession);
	registerIpc();
	configurePermissions();
	createApplicationMenu();
	createTray();
	nativeTheme.on("updated", () => {
		if (connectWindow && !connectWindow.isDestroyed())
			connectWindow.setBackgroundColor(windowBackground());
	});
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
		if (!startHidden) await showConnectWindow(launchConnectView ?? undefined);
	} else {
		const startup = await prepareDesktopStartup(cli);
		setTrayState(startup.state);
		// The dashboard opens after sign-in and on explicit clicks, not on every launch.
		if (!startHidden) await showConnectWindow(launchConnectView ?? undefined);
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

function registerDeepLinkProtocol(): void {
	// Packaged builds only: a development registration would point the OS at this checkout.
	// macOS and Linux packages also declare the scheme through electron-builder `protocols`.
	if (!app.isPackaged) return;
	if (!app.setAsDefaultProtocolClient(DESKTOP_DEEP_LINK_SCHEME)) {
		console.warn("Could not register Clawdi Desktop links");
	}
}

function registerAppProtocol(targetSession: Session): void {
	targetSession.protocol.handle(APP_SCHEME, (request) => {
		const url = new URL(request.url);
		const font = APP_FONT.exec(url.pathname)?.[1];
		const asset =
			url.host === APP_HOST
				? (APP_ASSETS.get(url.pathname) ?? (font ? join("files", font) : null))
				: null;
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

function updateActionMenuItems(): MenuItemConstructorOptions[] {
	if (updateState.status === "disabled") return [];
	const status = desktopUpdateStatusLabel(updateState);
	const items: MenuItemConstructorOptions[] = status ? [{ label: status, enabled: false }] : [];
	if (updateState.status === "ready") {
		items.push({
			label: "Restart to Update",
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
	const parent = [dashboardWindow, connectWindow].find(
		(window) => window && !window.isDestroyed() && window.isVisible(),
	);
	if (!parent) return;
	updatePromptedVersion = updateState.version;
	const choice = await showMessageBox(
		{
			type: "info",
			message: `Clawdi ${updateState.version} is ready`,
			detail: `Choose Later to keep working, then use Restart to Update from ${
				process.platform === "darwin" ? "the Clawdi menu" : "the File menu or the tray"
			}.`,
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
	ipcMain.handle(DESKTOP_IPC.createDashboardSession, async (event, raw: unknown) => {
		assertDashboardSender(event, dashboardWindow?.webContents, true, WEB_ORIGIN);
		try {
			const state = await cli.bootstrapState();
			if (signingOut || !state.auth.authenticated || state.auth.user?.id !== dashboardAccountId) {
				throw new Error("Local account changed.");
			}
			const result = await cli.createDashboardSession(readDesktopWebSession(raw));
			// Recheck after the exchange: concurrent CLI logout/account switching cannot restore stale cookies.
			const current = await cli.bootstrapState();
			if (
				signingOut ||
				current.auth.user?.id !== dashboardAccountId ||
				!current.auth.authenticated
			) {
				throw new Error("Local account changed.");
			}
			assertDashboardSender(event, dashboardWindow?.webContents, true, WEB_ORIGIN);
			return result;
		} catch {
			throw new Error("Couldn't restore dashboard sign-in. Reopen Dashboard from Clawdi.");
		}
	});
	ipcMain.handle(DESKTOP_IPC.signOut, async (event) => {
		assertDashboardSender(event, dashboardWindow?.webContents, false, WEB_ORIGIN);
		try {
			await signOutOfDesktop();
		} catch {
			throw new Error("Couldn't finish signing out. Retry from the Clawdi menu.");
		}
	});
	ipcMain.on(DESKTOP_IPC.openConnector, (event) => {
		runAsync(
			"open Connect",
			(async () => {
				assertDashboardSender(event, dashboardWindow?.webContents, false, WEB_ORIGIN);
				await showAvailableWindow("connect");
			})(),
		);
	});
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
			let result: DesktopAuthenticationResult;
			try {
				result = await authenticateAccount();
			} finally {
				verificationPage = null;
			}
			console.info("Desktop sign-in result", result.status);
			if (result.status === "cancelled") {
				return { status: "cancelled" as const };
			}
			setTrayState(result.state);
			return result;
		}),
	);
	ipcMain.handle(DESKTOP_IPC.reopenVerificationPage, (event) =>
		safeConnectAction(event, "open the sign-in page", async () => {
			const page = verificationPageToOpen(verificationPage);
			if (!page) return { status: "not-active" as const };
			await shell.openExternal(page);
			return { status: "opened" as const };
		}),
	);
	ipcMain.handle(DESKTOP_IPC.takeRequestedView, (event) =>
		safeConnectAction(event, "open the requested view", async () => {
			const view = requestedConnectView;
			requestedConnectView = null;
			return view;
		}),
	);
	ipcMain.handle(DESKTOP_IPC.listExcludedProjects, (event) =>
		safeConnectAction(event, "load excluded projects", () => {
			assertRuntimeLocation();
			return cli.listExcludedProjects();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.addExcludedProject, (event) =>
		safeConnectAction(event, "exclude the project", () => {
			assertRuntimeLocation();
			return addExcludedProject();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.removeExcludedProject, (event, path: unknown) =>
		safeConnectAction(event, "stop excluding the project", async () => {
			assertRuntimeLocation();
			const current = await cli.listExcludedProjects();
			const removed = readExcludedProjectRemoval(path, current);
			return cli.setExcludedProjects(current.filter((project) => project !== removed));
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
			runAsync(
				"open the dashboard after the first connection",
				openDashboardAfterFirstConnection(),
			);
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
			if (dashboardWindow && window && !window.isDestroyed()) window.destroy();
		}),
	);
}

async function authenticateAccount(): Promise<DesktopAuthenticationResult> {
	return authenticateDesktopAccount({
		bootstrapState: () => cli.bootstrapState(),
		authenticate: () =>
			cli.authenticate((progress) => {
				verificationPage = progress.verificationUri;
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
		assertConnectSender(event, connectWindow?.webContents, CONNECT_URL);
		return await action();
	} catch (error) {
		console.error(`Could not ${label}`, error);
		if (error instanceof DesktopCliError || error instanceof DesktopConnectError) throw error;
		throw new Error(`Couldn't ${label}. Try again.`);
	}
}

async function addExcludedProject(): Promise<DesktopExcludedProjectAddResult> {
	const current = await cli.listExcludedProjects();
	const parent = activeDialogParent();
	const options = {
		title: "Exclude a Project",
		buttonLabel: "Exclude",
		properties: ["openDirectory" as const],
	};
	const choice = parent
		? await dialog.showOpenDialog(parent, options)
		: await dialog.showOpenDialog(options);
	const path = choice.filePaths[0];
	if (choice.canceled || !path) return { status: "cancelled", projects: current };
	if (current.includes(path)) return { status: "exists", projects: current };
	return { status: "added", projects: await cli.setExcludedProjects([...current, path]) };
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
	const dashboard = session.fromPartition(DASHBOARD_PARTITION);
	dashboard.setPermissionCheckHandler(
		(contents, permission, requestingOrigin, details) =>
			contents === dashboardWindow?.webContents &&
			allowsDashboardPermission(permission, requestingOrigin, details.isMainFrame, WEB_ORIGIN),
	);
	dashboard.setPermissionRequestHandler((contents, permission, callback, details) =>
		callback(
			contents === dashboardWindow?.webContents &&
				allowsDashboardPermission(
					permission,
					details.requestingUrl,
					details.isMainFrame,
					WEB_ORIGIN,
				),
		),
	);
	dashboard.setDevicePermissionHandler(() => false);
	dashboard.on("will-download", (event) => event.preventDefault());
	session.defaultSession.setPermissionCheckHandler(() => false);
	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
		callback(false),
	);
	session.defaultSession.on("will-download", (event) => event.preventDefault());
}

function createApplicationMenu(): void {
	Menu.setApplicationMenu(
		Menu.buildFromTemplate(applicationMenuTemplate(menuState(), menuActions)),
	);
}

function menuState(): DesktopMenuState {
	const loginItem = readLoginItemSettings();
	return {
		platform: process.platform,
		appName: app.name,
		account: trayState?.auth.authenticated ? { email: trayState.auth.user?.email ?? null } : null,
		syncStatus: syncStatus(),
		syncChecked: trayState?.daemon.installed === true,
		syncToggleEnabled: trayState !== null && !trayStateChecking && activeCriticalOperations === 0,
		busy: activeCriticalOperations > 0,
		updateItems: updateActionMenuItems(),
		...(supportsDesktopLoginItems()
			? {
					loginItem: {
						checked: loginItem?.openAtLogin === true,
						enabled: app.isPackaged && loginItem !== null,
						note: !loginItem
							? "Login Item: Unavailable"
							: loginItem.status === "requires-approval"
								? "Login Item Requires Approval"
								: null,
					},
				}
			: {}),
	};
}

const menuActions: DesktopMenuActions = {
	openDashboard: () => runAsync("open the dashboard", openDashboard()),
	connectAgents: () => runAsync("open Connect Agents", showConnectWindow("connect")),
	fixSync: () => runAsync("open Fix Sync", showConnectWindow("fix-sync")),
	excludeProjects: () => runAsync("open Exclude Projects", showConnectWindow("exclude-projects")),
	setSync: (enabled) => runAsync("change sync", setSyncEnabled(enabled)),
	setLaunchAtLogin: (enabled) => runAsync("change the login item", setLaunchAtLogin(enabled)),
	openDocs: () => runAsync("open the docs", shell.openExternal(DOCS_URL)),
	contactSupport: () => runAsync("contact support", shell.openExternal(SUPPORT_URL)),
	showLogs: () => runAsync("show logs", showLogs()),
	signOut: () => runAsync("sign out of Desktop", signOutOfDesktop()),
	quit: () => app.quit(),
};

async function showLogs(): Promise<void> {
	// app.setAppLogsPath() creates this directory at startup.
	const failure = await shell.openPath(getDesktopLogDirectory(app));
	if (failure) throw new Error(failure);
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
					message: `The ${label} couldn't recover`,
					detail: "Close this window and open it again from Clawdi.",
				},
				window,
			),
		);
	});
}

async function showConnectWindow(view?: DesktopConnectView): Promise<void> {
	if (process.platform === "darwin") await app.dock?.show();
	if (view) requestedConnectView = view;
	if (connectWindow) {
		if (view && !connectWindow.isDestroyed())
			connectWindow.webContents.send(DESKTOP_IPC.viewRequested);
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
		backgroundColor: windowBackground(),
		title: "Clawdi",
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
	hardenLocalWindow(window, CONNECT_URL, "Connect window", 1);
	window.once("ready-to-show", () => window.show());
	window.on("closed", () => {
		runAsync("cancel sign-in", cli.cancelAuthentication());
		if (connectWindow === window) {
			connectWindow = null;
			requestedConnectView = null;
		}
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
	tray.setToolTip(`Clawdi · ${desktopSyncStatusLabel(syncStatus())}`);
	tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(menuState(), menuActions)));
}

function syncStatus(): DesktopSyncStatus {
	if (trayStateChecking) return "checking";
	if (!trayState) return "unavailable";
	if (!trayState.auth.authenticated) return "signed-out";
	if (!trayState.daemon.installed) return "off";
	return trayState.daemon.running ? "running" : "attention";
}

function setTrayState(state: DesktopBootstrapState | null): void {
	trayState = state;
	trayStateChecking = false;
	renderUpdateMenus();
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
			const state = await cli.bootstrapState();
			if (
				dashboardAccountId &&
				(!state.auth.authenticated || state.auth.user?.id !== dashboardAccountId)
			) {
				dashboardAccountId = state.auth.authenticated ? (state.auth.user?.id ?? null) : null;
				if (dashboardWindow && !dashboardWindow.isDestroyed())
					await dashboardWindow.loadURL(`${WEB_ORIGIN}/desktop-auth`);
			}
			setTrayState(state);
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
			detail: "Open Connect Agents to check the local setup.",
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
			detail: "Try again, or open Connect Agents to check the local setup.",
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

async function showAvailableWindow(view?: DesktopConnectView): Promise<void> {
	if (view) {
		await showConnectWindow(view);
		return;
	}
	if (dashboardWindow && !dashboardWindow.isDestroyed()) {
		await openDashboard();
		return;
	}

	if (connectWindow) {
		await showConnectWindow(view);
		return;
	}
	// The new window takes the request when its renderer starts.
	if (view) requestedConnectView = view;
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
	await showConnectWindow();
	if (!startup.requiresWizard) {
		runAsync("reconcile sync after opening Clawdi", reconcileBackgroundSyncAfterStartup());
	}
}

async function reconcileBackgroundSyncAfterStartup(): Promise<void> {
	const recovery = await reconcileDesktopStartupSync(cli);
	setTrayState(recovery.state);
}

async function openDashboardAfterFirstConnection(): Promise<void> {
	if (claimFirstConnection(join(app.getPath("userData"), "first-connection")))
		await openDashboard();
}

async function openDashboard(): Promise<void> {
	if (signingOut) return;
	if (dashboardOpening) return dashboardOpening;
	const opening = openDashboardWindow();
	dashboardOpening = opening;
	try {
		await opening;
	} finally {
		if (dashboardOpening === opening) dashboardOpening = null;
	}
}

async function openDashboardWindow(): Promise<void> {
	const state = await cli.bootstrapState();
	setTrayState(state);
	if (signingOut) return;
	if (!state.auth.authenticated || !state.auth.user) {
		await clearDashboardSession();
		await showConnectWindow();
		return;
	}
	const accountChanged = dashboardAccountId !== state.auth.user.id;
	if (signingOut) return;
	dashboardAccountId = state.auth.user.id;
	if (dashboardWindow && !dashboardWindow.isDestroyed()) {
		if (dashboardWindow.isMinimized()) dashboardWindow.restore();
		dashboardWindow.show();
		dashboardWindow.focus();
		if (accountChanged) await dashboardWindow.loadURL(`${WEB_ORIGIN}/desktop-auth`);
		return;
	}
	if (process.platform === "darwin") await app.dock?.show();
	const preload = join(fileURLToPath(new URL(".", import.meta.url)), "shell-preload.cjs");
	const window = new BrowserWindow({
		...dashboardWindowOptions(preload, WEB_ORIGIN),
		backgroundColor: windowBackground(),
		...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
	});
	dashboardWindow = window;
	window.webContents.setWindowOpenHandler(({ url }) => {
		const external = strictHttpsUrl(url);
		if (external) runAsync("open the external link", shell.openExternal(external.href));
		return { action: "deny" };
	});
	const navigate = (event: Electron.Event, url: string, mainFrame: boolean) => {
		const redirect = mainFrame && dashboardAuthRedirect(url, WEB_ORIGIN);
		if (redirect) {
			event.preventDefault();
			runAsync("restore dashboard sign-in", window.loadURL(redirect));
		} else if (!allowsDashboardNavigation(url, WEB_ORIGIN, CLERK_ORIGINS, mainFrame))
			event.preventDefault();
	};
	window.webContents.on("will-frame-navigate", (event) =>
		navigate(event, event.url, event.isMainFrame),
	);
	window.webContents.on("will-redirect", (event, url, _inPlace, mainFrame) =>
		navigate(event, url, mainFrame),
	);
	// SPA history changes don't emit will-frame-navigate.
	window.webContents.on("did-navigate-in-page", (_event, url, mainFrame) => {
		const redirect = mainFrame && dashboardAuthRedirect(url, WEB_ORIGIN);
		if (redirect) runAsync("restore dashboard sign-in", window.loadURL(redirect));
	});
	window.webContents.on("will-attach-webview", (event) => event.preventDefault());
	window.webContents.on("render-process-gone", () => {
		if (!window.isDestroyed()) window.destroy();
	});
	window.once("ready-to-show", () => {
		if (!signingOut && !window.isDestroyed()) window.show();
	});
	window.on("closed", () => {
		if (dashboardWindow === window) dashboardWindow = null;
	});
	try {
		await window.loadURL(`${WEB_ORIGIN}/desktop-auth`);
	} catch {
		if (!window.isDestroyed()) window.destroy();
		await showMessageBox({
			type: "warning",
			message: "Dashboard couldn't load",
			detail: "Check your connection and open Dashboard again from Clawdi.",
		});
		throw new DesktopConnectError("Dashboard couldn't load.");
	}
}

async function clearDashboardSession(): Promise<void> {
	dashboardAccountId = null;
	if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.destroy();
	await session.fromPartition(DASHBOARD_PARTITION).clearData();
}

async function signOutOfDesktop(): Promise<void> {
	if (signingOut) return;
	signingOut = true;
	try {
		// Revoke first; retain local credentials if revocation fails so the user can retry.
		const partition = session.fromPartition(DASHBOARD_PARTITION);
		for (const id of dashboardSessionIds(await partition.cookies.get({ url: WEB_ORIGIN })))
			await cli.revokeDashboardSession(id);
		// Remove local credentials even when Chromium storage or daemon cleanup fails.
		try {
			await clearDashboardSession();
		} finally {
			await withCriticalOperation(async () => {
				try {
					await cli.cancelAuthentication();
				} finally {
					await cli.logout();
				}
			});
		}
		setTrayState(await cli.bootstrapState());
		if (connectWindow && !connectWindow.isDestroyed()) connectWindow.webContents.reload();
		await showConnectWindow();
	} finally {
		signingOut = false;
	}
}

function windowBackground(): string {
	return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
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
