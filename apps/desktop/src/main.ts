import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
	DesktopAgentConnection,
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
	type MessageBoxOptions,
	nativeImage,
	net,
	protocol,
	type Session,
	session,
	shell,
	Tray,
} from "electron";
import {
	authenticateDesktopAccount,
	type DesktopAuthenticationFlowResult,
	DesktopAuthenticationTransitionError,
	prepareDesktopStartup,
	reconcileDesktopStartupSync,
} from "./auth-orchestrator";
import {
	allowsChildClipboard,
	allowsChildDownload,
	type DashboardChildKind,
	type DashboardChildState,
	dashboardChildUrl,
	evaluateChildNavigation,
} from "./child-window-policy";
import { DESKTOP_IPC } from "./ipc";
import { DesktopCliError, DesktopCliService } from "./native-cli";
import { DesktopUpdateController } from "./update-controller";
import { evaluateDesktopUpdatePolicy } from "./update-policy";
import { readMacCodeSignature } from "./update-signature";
import { type DesktopUpdateState, desktopUpdateStatusLabel } from "./update-state";

const APP_SCHEME = "clawdi-app";
const APP_HOST = "connect";
const DASHBOARD_ORIGIN = "https://cloud.clawdi.ai";
// Intentionally in-memory: CLI credentials are the only durable auth source.
// Each app launch exchanges them for a fresh, process-scoped Clerk session.
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
	["/clawdi-logo.png", "clawdi-logo.png"],
]);
const cli = new DesktopCliService();
let mainWindow: BrowserWindow | null = null;
let connectWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayState: DesktopBootstrapState | null = null;
let trayStateChecking = true;
let trayStateRefresh: Promise<void> | null = null;
let availableWindowOpening: Promise<void> | null = null;
let dashboardWindowOpening: Promise<DashboardLoadResult> | null = null;
let dashboardFailureOpening: Promise<void> | null = null;
let dashboardSession: Session | null = null;
let dashboardAccountId: string | null = null;
const dashboardChildWindows = new Map<BrowserWindow, DashboardChildState>();
let restoreMainWindowAfterConnect = false;
let updateController: DesktopUpdateController | null = null;
let updateState: DesktopUpdateState = { status: "disabled", reason: "development" };
let updatePromptedVersion: string | null = null;
let activeCriticalOperations = 0;
let quitting = false;

class DesktopConnectError extends Error {}

type DashboardLoadResult = "opened" | "connect-required" | "failed";
function runAsync(label: string, operation: Promise<unknown>): void {
	void operation.catch((error) => console.error(`Could not ${label}`, error));
}

function activeDialogParent(preferred?: BrowserWindow | null): BrowserWindow | null {
	if (preferred && !preferred.isDestroyed()) return preferred;
	return (
		[mainWindow, connectWindow, ...dashboardChildWindows.keys()].find(
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
			else await loadDashboardWithRecovery();
		}
		if (!startup.requiresWizard) {
			runAsync("reconcile background sync after startup", reconcileBackgroundSyncAfterStartup());
		}
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

function registerDashboardProtocol(targetSession: Session): void {
	const assets = readDashboardAssets();
	const index = assets.get("/index.html");
	if (!index) throw new Error("The packaged Dashboard is missing its SPA shell.");
	const indexHtml = readFileSync(index, "utf8");

	targetSession.protocol.handle("https", async (request) => {
		const url = new URL(request.url);
		if (url.origin !== DASHBOARD_ORIGIN) {
			return targetSession.fetch(request, { bypassCustomProtocolHandlers: true });
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}

		const asset = assets.get(url.pathname);
		if (asset === index || (!asset && isDocumentRequest(request))) {
			return dashboardDocumentResponse(indexHtml, request.method);
		}
		if (asset) return localAssetResponse(asset, request.method);
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

function dashboardDocumentResponse(indexHtml: string, method: string): Response {
	const nonce = randomBytes(18).toString("base64");
	const html = indexHtml.replace(/<script\b(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`);
	return new Response(method === "HEAD" ? null : html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": [
				"default-src 'self'",
				"base-uri 'self'",
				"object-src 'none'",
				"frame-ancestors 'none'",
				`script-src 'self' 'nonce-${nonce}'`,
				"script-src-attr 'none'",
				"style-src 'self' 'unsafe-inline'",
				"font-src 'self' data:",
				"img-src 'self' data: blob: https:",
				"connect-src 'self' https: wss:",
				"frame-src https:",
				"worker-src 'self' blob:",
				"form-action 'self' https:",
			].join("; "),
			"Referrer-Policy": "strict-origin-when-cross-origin",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function isDocumentRequest(request: Request): boolean {
	return (
		request.destination === "document" ||
		(request.headers.get("accept") ?? "").includes("text/html")
	);
}

async function initializeUpdates(): Promise<void> {
	const channel = readPackageMetadataField("clawdiUpdateChannel");
	const feedUrl = readPackageMetadataField("clawdiUpdateFeedUrl");
	const shouldInspectSignature =
		app.isPackaged && process.platform === "darwin" && process.mas !== true && channel === "stable";
	const signature = shouldInspectSignature ? await readMacCodeSignature(process.execPath) : null;
	const policy = evaluateDesktopUpdatePolicy({
		isPackaged: app.isPackaged,
		platform: process.platform,
		isMacAppStore: process.mas === true,
		channel,
		feedUrl,
		signature,
	});
	if (!policy.enabled) console.info(`Desktop updates disabled: ${policy.reason}`);
	updateController = new DesktopUpdateController({
		policy,
		onStateChange: (state) => {
			updateState = state;
			renderUpdateMenus();
		},
		onUpdateReady: () => runAsync("offer the downloaded update", maybePromptForUpdate()),
	});
	updateController.start();
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

function trayUpdateMenuItems(): MenuItemConstructorOptions[] {
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
			enabled: activeCriticalOperations === 0,
			click: restartToInstallUpdate,
		});
	} else if (updateState.status === "idle" || updateState.status === "error") {
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
		activeCriticalOperations > 0 ||
		updatePromptedVersion === updateState.version
	) {
		return;
	}
	const parent = [mainWindow, connectWindow].find(
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
	if (activeCriticalOperations > 0 || !updateController) return;
	quitting = true;
	if (!updateController.installDownloadedUpdate()) quitting = false;
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
	ipcMain.handle(DESKTOP_IPC.listReconnectableAgents, (event) =>
		safeConnectAction(event, "find reconnectable Agents", () => {
			assertRuntimeLocation();
			return cli.listReconnectableAgents();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.authenticate, (event) =>
		safeConnectAction(event, "sign in", async () => {
			assertRuntimeLocation();
			const result = await authenticateAndResumeSync();
			if (result.status === "cancelled") {
				return { status: "cancelled" as const };
			}
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
	ipcMain.handle(DESKTOP_IPC.connectAgents, (event, rawConnections: unknown) =>
		safeConnectAction(event, "connect the selected Agents", async () => {
			assertSafeDaemonMutation();
			const result = await withCriticalOperation(() =>
				cli.connectAgents(readAgentConnections(rawConnections)),
			);
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
			const window = connectWindow;
			const result = await loadDashboardWithRecovery();
			if (result === "connect-required") return;
			runAsync(
				"reconcile background sync after opening Dashboard",
				reconcileBackgroundSyncAfterStartup(),
			);
			restoreMainWindowAfterConnect = false;
			if (window && !window.isDestroyed()) window.destroy();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.signIn, (event) =>
		safeDashboardAction(event, "sign in", async () => {
			assertRuntimeLocation();
			let result: DesktopAuthenticationFlowResult;
			try {
				result = await authenticateAndResumeSync(true);
			} catch (error) {
				if (error instanceof DesktopAuthenticationTransitionError) {
					await applyAuthenticationRecovery(error.recovery);
				}
				throw error;
			}
			if (result.status === "cancelled") {
				await applyAuthenticationRecovery(result);
				return { status: "cancelled" as const };
			}
			if (result.requiresWizard) {
				await applyAuthenticationRecovery({
					restoreDashboard: false,
					requiresWizard: true,
					needsAttention: result.needsAttention,
				});
				return { status: "authenticated" as const };
			}
			if ((await loadDashboardWithRecovery(true)) !== "opened") {
				throw new Error("Dashboard sign-in did not complete.");
			}
			return { status: "authenticated" as const };
		}),
	);
	ipcMain.handle(DESKTOP_IPC.signOut, (event) =>
		safeDashboardAction(event, "sign out", async () => {
			await withCriticalOperation(async () => {
				await cli.cancelAuthentication();
				await cli.logout();
			});
			restoreMainWindowAfterConnect = false;
			if (connectWindow && !connectWindow.isDestroyed()) connectWindow.destroy();
			await clearDashboardSession();
			setTrayState(trayState ? { ...trayState, auth: { authenticated: false, user: null } } : null);
			if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
			await showConnectWindow();
		}),
	);
	registerDashboardChildWindowIpc(DESKTOP_IPC.openFilesWindow, "files", "Files");
	registerDashboardChildWindowIpc(DESKTOP_IPC.openRuntimeWindow, "runtime", "runtime UI");
	registerDashboardChildWindowIpc(DESKTOP_IPC.openTerminalWindow, "terminal", "Terminal");
	ipcMain.handle(DESKTOP_IPC.openConnectWizard, (event) =>
		safeDashboardAction(event, "open Connect Agent", async () => {
			const shouldRestore = mainWindow?.isVisible() === true;
			await showConnectWindow();
			restoreMainWindowAfterConnect ||= shouldRestore;
			mainWindow?.hide();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.retryDashboard, (event) =>
		safeDashboardAction(event, "reconnect the dashboard", async () => {
			if ((await loadDashboardWithRecovery(true)) === "failed") {
				throw new Error("Dashboard reconnection failed.");
			}
		}),
	);
}

function registerDashboardChildWindowIpc(
	channel: string,
	kind: DashboardChildKind,
	label: string,
): void {
	ipcMain.handle(channel, (event, rawUrl: unknown) =>
		safeDashboardAction(event, `open ${label}`, async () => {
			if (typeof rawUrl !== "string") throw new Error(`Invalid ${label} URL.`);
			const url = dashboardChildUrl(rawUrl, kind, DASHBOARD_ORIGIN);
			if (!url) {
				throw new Error(`Invalid ${label} URL.`);
			}
			const child = createDashboardChildWindow({ kind, origin: url.origin });
			try {
				await child.loadURL(url.href);
				return true;
			} catch (error) {
				if (!child.isDestroyed()) child.destroy();
				throw error;
			}
		}),
	);
}

async function authenticateAndResumeSync(force = false): Promise<DesktopAuthenticationFlowResult> {
	return authenticateDesktopAccount(
		{
			bootstrapState: () => cli.bootstrapState(),
			getAuthState: () => cli.getAuthState(),
			authenticate: (forceAuthentication) => cli.authenticate(forceAuthentication),
			stopDaemon: () => withCriticalOperation(() => cli.stopDaemon()),
			restartDaemon: () => withCriticalOperation(() => cli.restartDaemon()),
		},
		{
			force,
			beforeAuthentication: force
				? async () => {
						await waitForDashboardOpening();
						await clearDashboardSession();
						mainWindow?.hide();
					}
				: undefined,
		},
	);
}

async function applyAuthenticationRecovery(recovery: {
	restoreDashboard: boolean;
	requiresWizard: boolean;
	needsAttention: boolean;
}): Promise<void> {
	try {
		setTrayState(await cli.bootstrapState());
	} catch (error) {
		console.error("Could not refresh state after sign-in recovery", error);
		setTrayState(null);
	}
	if (recovery.requiresWizard) {
		await showConnectRequired();
		return;
	}
	if (recovery.restoreDashboard) await loadDashboardWithRecovery(true);
}

async function withCriticalOperation<T>(action: () => Promise<T>): Promise<T> {
	activeCriticalOperations += 1;
	renderUpdateMenus();
	try {
		return await action();
	} finally {
		activeCriticalOperations -= 1;
		renderUpdateMenus();
		if (activeCriticalOperations === 0)
			runAsync("offer the downloaded update", maybePromptForUpdate());
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

function readAgentConnections(value: unknown): DesktopAgentConnection[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("Choose at least one supported Agent.");
	}
	const connections: DesktopAgentConnection[] = [];
	const types = new Set<DesktopAgentType>();
	for (const item of value) {
		if (!isRecord(item) || !isDesktopAgentType(item.type) || types.has(item.type)) {
			throw new Error("Choose each supported Agent once.");
		}
		const reconnectAgentId = item.reconnectAgentId;
		const confirmTakeover = item.confirmTakeover;
		if (
			reconnectAgentId !== undefined &&
			(typeof reconnectAgentId !== "string" ||
				!reconnectAgentId.trim() ||
				reconnectAgentId.length > 256)
		) {
			throw new Error("Choose a valid Agent to reconnect.");
		}
		if (confirmTakeover !== undefined && typeof confirmTakeover !== "boolean") {
			throw new Error("Choose a valid Agent takeover confirmation.");
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

function configurePermissions(dashboardSession: Session): void {
	session.defaultSession.setPermissionCheckHandler(() => false);
	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
		callback(false);
	});
	session.defaultSession.on("will-download", (event) => event.preventDefault());

	const allowsClipboardWrite = (
		webContents: Electron.WebContents | null,
		permission: string,
		requestingUrl: string,
		embeddingUrl: string,
	) => {
		if (permission !== "clipboard-sanitized-write" || !webContents) return false;
		if (webContents === mainWindow?.webContents) {
			return (
				urlOrigin(requestingUrl) === DASHBOARD_ORIGIN &&
				urlOrigin(embeddingUrl) === DASHBOARD_ORIGIN
			);
		}
		const owner = BrowserWindow.fromWebContents(webContents);
		const state = owner ? dashboardChildWindows.get(owner) : undefined;
		return Boolean(
			state && allowsChildClipboard(state, webContents.getURL(), requestingUrl, embeddingUrl),
		);
	};
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
	dashboardSession.on("will-download", (event, item, webContents) => {
		const owner = BrowserWindow.fromWebContents(webContents);
		const state = owner ? dashboardChildWindows.get(owner) : undefined;
		if (!state || !allowsChildDownload(state, webContents.getURL(), item.getURL())) {
			event.preventDefault();
		}
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
	const viewMenu: MenuItemConstructorOptions = {
		label: "View",
		submenu: [
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
		...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
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

	window.webContents.setWindowOpenHandler((details) => {
		if (isSafeExternalUrl(details.url)) {
			runAsync("open the external link", shell.openExternal(details.url));
		}
		return { action: "deny" };
	});
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
		runAsync("recover the dashboard renderer", showDashboardFailure(true, window.isVisible()));
	});
	window.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		window.hide();
	});
	window.on("closed", () => {
		closeDashboardChildWindows();
		if (mainWindow === window) mainWindow = null;
	});

	await loadWindowUrl(window, initialUrl);
}

function createDashboardChildWindow(state: DashboardChildState): BrowserWindow {
	const icon = desktopIcon();
	const window = new BrowserWindow({
		show: false,
		width: 1120,
		height: 760,
		minWidth: 720,
		minHeight: 480,
		...(icon.isEmpty() ? {} : { icon }),
		webPreferences: {
			partition: DASHBOARD_PARTITION,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			spellcheck: false,
		},
	});
	configureDashboardChildWindow(window, state);
	return window;
}

function configureDashboardChildWindow(window: BrowserWindow, state: DashboardChildState): void {
	dashboardChildWindows.set(window, state);
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	const guardNavigation = (event: Electron.Event, url: string) => {
		const decision = evaluateChildNavigation(url, state);
		if (decision.action === "allow") return;
		event.preventDefault();
		if (decision.action === "external") {
			runAsync("open the child window link externally", shell.openExternal(url));
		}
	};
	window.webContents.on("will-navigate", guardNavigation);
	window.webContents.on("will-redirect", guardNavigation);
	window.once("ready-to-show", () => {
		if (!window.isDestroyed()) window.show();
	});
	window.webContents.on("render-process-gone", (_event, details) => {
		if (quitting || window.isDestroyed()) return;
		console.error(`Dashboard child renderer exited: ${details.reason}`);
		window.destroy();
	});
	window.on("closed", () => dashboardChildWindows.delete(window));
}

function closeDashboardChildWindows(): void {
	for (const window of dashboardChildWindows.keys()) {
		if (!window.isDestroyed()) window.destroy();
	}
	dashboardChildWindows.clear();
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
					message: `${label} could not recover`,
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
	hardenLocalWindow(window, CONNECT_URL, "Connect Agent", 1);
	window.once("ready-to-show", () => window.show());
	window.on("closed", () => {
		const shouldRestore = restoreMainWindowAfterConnect;
		restoreMainWindowAfterConnect = false;
		runAsync("cancel sign-in", cli.cancelAuthentication());
		if (connectWindow === window) connectWindow = null;
		if (shouldRestore && !quitting) {
			runAsync("restore the dashboard", showMainWindow());
		}
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
			enabled: activeCriticalOperations === 0,
			click: () =>
				runAsync(
					"repair background sync",
					trayState?.daemon.installed ? restartBackgroundSync() : showConnectWindow(),
				),
		},
		...(trayState?.daemon.installed
			? ([
					{
						label: "Turn Off Background Sync",
						enabled: activeCriticalOperations === 0,
						click: () => runAsync("turn off background sync", turnOffBackgroundSync()),
					},
				] satisfies MenuItemConstructorOptions[])
			: []),
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
	template.push(...trayUpdateMenuItems());

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
		await withCriticalOperation(() => cli.restartDaemon());
		await refreshTrayState();
		setTimeout(() => runAsync("refresh background sync status", refreshTrayState()), 2_000).unref();
	} catch (error) {
		console.error("Could not restart background sync", error);
		setTrayState(null);
		const choice = await showMessageBox({
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

async function turnOffBackgroundSync(): Promise<void> {
	trayStateChecking = true;
	renderTrayMenu();
	try {
		await withCriticalOperation(() => cli.uninstallDaemon());
		await refreshTrayState();
	} catch (error) {
		console.error("Could not turn off background sync", error);
		await refreshTrayState();
		await showMessageBox({
			type: "warning",
			message: "Background sync could not be turned off",
			detail: "Try again, or open Connect Agent to inspect the local setup.",
		});
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
	await showMessageBox({
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
				showMessageBoxSync({
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
			message: "Clawdi could not be moved",
			detail: "Move Clawdi to Applications in Finder, reopen it, and try again.",
		});
	}
}

async function showAvailableWindow(): Promise<void> {
	if (connectWindow) {
		await showConnectWindow();
		return;
	}
	if (mainWindow) {
		await showWindowFromTrayState();
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
	await loadDashboardWithRecovery();
	runAsync("reconcile background sync after opening Clawdi", reconcileBackgroundSyncAfterStartup());
}

async function reconcileBackgroundSyncAfterStartup(): Promise<void> {
	const recovery = await reconcileDesktopStartupSync(cli);
	setTrayState(recovery.state);
}

async function showMainWindow(): Promise<void> {
	const window = mainWindow;
	if (!window || window.isDestroyed()) {
		await loadDashboardWithRecovery();
		return;
	}
	await presentMainWindow(window);
}

async function loadDashboardWithRecovery(
	forceAuthentication = false,
): Promise<DashboardLoadResult> {
	if (dashboardWindowOpening) {
		if (!forceAuthentication) return dashboardWindowOpening;
		await waitForDashboardOpening();
	}
	const opening = (async () => {
		try {
			const state = await cli.bootstrapState();
			setTrayState(state);
			if (!state.auth.authenticated || !state.auth.user) {
				await showConnectRequired();
				return "connect-required" as const;
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
				return "opened" as const;
			}

			await prepareDashboardSession(state.auth.user.id, forceAuthentication);
			const readyWindow = mainWindow;
			if (!readyWindow || readyWindow.isDestroyed()) throw new Error("Dashboard window was closed");
			await presentMainWindow(readyWindow);
			return "opened" as const;
		} catch (error) {
			console.error("Could not open the dashboard", error);
			try {
				const auth = await cli.getAuthState();
				if (!auth.authenticated || !auth.user) {
					setTrayState(
						trayState ? { ...trayState, auth, daemon: { installed: false, running: false } } : null,
					);
					await showConnectRequired();
					return "connect-required" as const;
				}
			} catch (authError) {
				console.error("Could not re-check the local sign-in state", authError);
			}
			await showDashboardFailure();
			return "failed" as const;
		}
	})();
	dashboardWindowOpening = opening;
	try {
		return await opening;
	} finally {
		if (dashboardWindowOpening === opening) dashboardWindowOpening = null;
	}
}

async function showDashboardFailure(forceReload = false, present = true): Promise<void> {
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
		if (present) await presentMainWindow(window);
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
	runAsync("offer the downloaded update", maybePromptForUpdate());
}

async function prepareDashboardSession(
	accountId: string,
	forceAuthentication: boolean,
): Promise<void> {
	if (forceAuthentication || (dashboardAccountId && dashboardAccountId !== accountId)) {
		await clearDashboardSession();
	}
	let window = mainWindow;
	if (!window || window.isDestroyed()) {
		await createMainWindow(DASHBOARD_SIGN_IN_URL);
		window = mainWindow;
	}
	if (!window || window.isDestroyed()) throw new Error("Dashboard window was closed");

	const ticket = await cli.createDashboardSession();
	const url = new URL("/desktop-auth", DASHBOARD_ORIGIN);
	url.hash = new URLSearchParams({ ticket }).toString();
	const ready = waitForDashboardReady(window, DASHBOARD_LOAD_TIMEOUT_MS);
	try {
		await loadWindowUrl(window, url.toString());
		await ready;
	} catch (error) {
		void ready.catch(() => undefined);
		throw error;
	}
	dashboardAccountId = accountId;
}

async function showConnectRequired(): Promise<void> {
	await clearDashboardSession();
	if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
	if (connectWindow && !connectWindow.isDestroyed()) connectWindow.webContents.reload();
	await showConnectWindow();
}

function waitForDashboardReady(window: BrowserWindow, timeoutMs: number): Promise<void> {
	return new Promise((resolvePromise, reject) => {
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
			else resolvePromise();
		}
	});
}

async function clearDashboardSession(): Promise<void> {
	dashboardAccountId = null;
	closeDashboardChildWindows();
	if (dashboardSession) await dashboardSession.clearData();
}

async function waitForDashboardOpening(): Promise<void> {
	const pending = dashboardWindowOpening;
	if (!pending) return;
	try {
		await pending;
	} catch {
		// The caller is replacing this process-scoped session; only completion matters.
	}
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
