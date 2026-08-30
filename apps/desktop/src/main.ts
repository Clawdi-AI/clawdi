import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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
	nativeImage,
	session,
	shell,
	Tray,
} from "electron";
import { DESKTOP_IPC } from "./ipc";
import { DesktopCliService } from "./native-cli";

const DEFAULT_WEB_URL = "https://cloud.clawdi.ai";
const cli = new DesktopCliService();
let mainWindow: BrowserWindow | null = null;
let connectWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => void showMainWindow());
	void app.whenReady().then(startApplication);
}

async function startApplication(): Promise<void> {
	app.setName("Clawdi");
	registerIpc();
	configurePermissions();
	createTray();
	try {
		const state = await cli.bootstrapState();
		if (state.auth.authenticated && state.daemon.running) {
			await prepareDashboardSession();
			await showMainWindow();
		} else {
			await showConnectWindow();
			if (state.auth.authenticated) void prepareDashboardSession();
		}
	} catch {
		await showConnectWindow();
	}

	app.on("activate", () => void showMainWindow());
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
			const authorization = await cli.startAuthentication();
			if (authorization) {
				const receiver = await createOAuthCallbackReceiver(
					authorization.redirectUri,
					authorization.expiresAt,
					authorization.authorizationUrl,
				);
				try {
					await shell.openExternal(authorization.authorizationUrl);
					await cli.finishAuthentication(await receiver.callback);
				} finally {
					await receiver.close();
				}
			}
			await prepareDashboardSession();
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
			await showMainWindow();
			connectWindow?.hide();
		}),
	);
	ipcMain.handle(DESKTOP_IPC.openConnectWizard, (event) =>
		safeDashboardAction(event, "open Connect Agent", showConnectWindow),
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
		throw new Error(`Could not ${label}. Check your connection and try again.`);
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
	session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
		callback(false);
	});
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
	tray = new Tray(icon.resize({ width: 18, height: 18 }));
	tray.setToolTip("Clawdi");
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "Open Clawdi", click: showMainWindow },
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
	tray.on("click", () => void showMainWindow());
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
	try {
		const ticket = await cli.createDashboardSession();
		const url = new URL("/desktop-auth", desktopWebUrl());
		url.hash = new URLSearchParams({ ticket }).toString();
		if (mainWindow) await mainWindow.loadURL(url.toString());
		else await createMainWindow(false, url.toString());
	} catch (error) {
		console.error("Could not prepare the dashboard session", error);
	}
}

function desktopWebUrl(): string {
	const raw = process.env.CLAWDI_DESKTOP_WEB_URL?.trim() || packagedWebUrl() || DEFAULT_WEB_URL;
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
			(url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
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

interface OAuthCallbackReceiver {
	callback: Promise<string>;
	close(): Promise<void>;
}

async function createOAuthCallbackReceiver(
	redirectUri: string,
	expiresAt: string,
	authorizationUrl: string,
): Promise<OAuthCallbackReceiver> {
	const redirect = new URL(redirectUri);
	const expectedState = new URL(authorizationUrl).searchParams.get("state")?.trim();
	const port = Number(redirect.port);
	if (
		redirect.protocol !== "http:" ||
		(redirect.hostname !== "127.0.0.1" && redirect.hostname !== "localhost") ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65_535 ||
		!expectedState ||
		redirect.pathname !== "/oauth/callback"
	) {
		throw new Error("Clawdi returned an unsupported browser callback.");
	}
	const timeoutMs = Math.max(1, Date.parse(expiresAt) - Date.now());
	let resolveCallback: (value: string) => void = () => undefined;
	let rejectCallback: (reason: Error) => void = () => undefined;
	const callback = new Promise<string>((resolvePromise, reject) => {
		resolveCallback = resolvePromise;
		rejectCallback = reject;
	});
	const server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", redirect.origin);
		if (request.method !== "GET" || requestUrl.pathname !== redirect.pathname) {
			response.writeHead(404).end();
			return;
		}
		if (requestUrl.searchParams.get("state") !== expectedState) {
			response.writeHead(400, {
				"Content-Type": "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
			});
			response.end("Invalid authorization state.");
			return;
		}
		const accepted = Boolean(requestUrl.searchParams.get("code"));
		response.writeHead(accepted ? 200 : 400, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		});
		response.end(
			"<!doctype html><meta charset=utf-8><title>Clawdi</title>" +
				`<body style='font:16px system-ui;padding:48px'>${
					accepted
						? "Sign-in complete. Return to Clawdi."
						: "Sign-in was not completed. Return to Clawdi and try again."
				}</body>`,
		);
		resolveCallback(requestUrl.toString());
	});
	await listen(server, redirect.hostname, port);
	const timeout = setTimeout(() => {
		rejectCallback(new Error("Browser authorization expired."));
		void closeServer(server);
	}, timeoutMs);
	return {
		callback,
		close: async () => {
			clearTimeout(timeout);
			await closeServer(server);
		},
	};
}

function listen(server: Server, host: string, port: number): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.removeListener("error", reject);
			resolvePromise();
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolvePromise) => {
		if (!server.listening) {
			resolvePromise();
			return;
		}
		server.close(() => resolvePromise());
	});
}
