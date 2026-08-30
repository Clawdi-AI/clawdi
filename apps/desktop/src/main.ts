import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
let tray: Tray | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => showMainWindow());
	void app.whenReady().then(startApplication);
}

async function startApplication(): Promise<void> {
	app.setName("Clawdi");
	registerIpc();
	configurePermissions();
	createTray();
	await createMainWindow();

	app.on("activate", () => showMainWindow());
	app.on("before-quit", () => {
		quitting = true;
	});
}

function registerIpc(): void {
	ipcMain.handle(DESKTOP_IPC.bootstrapState, (event) =>
		safeDesktopAction(event, "prepare the local runtime", () => cli.bootstrapState()),
	);
	ipcMain.handle(DESKTOP_IPC.detectAgents, (event) =>
		safeDesktopAction(event, "inspect local Agents", () => cli.detectAgents()),
	);
	ipcMain.handle(DESKTOP_IPC.authenticate, (event) =>
		safeDesktopAction(event, "sign in", async () => {
			const authorization = await cli.startAuthentication();
			if (!authorization) return cli.bootstrapState();
			const receiver = await createOAuthCallbackReceiver(
				authorization.redirectUri,
				authorization.expiresAt,
			);
			try {
				await shell.openExternal(authorization.authorizationUrl);
				await cli.finishAuthentication(await receiver.callback);
				return cli.bootstrapState();
			} finally {
				await receiver.close();
			}
		}),
	);
	ipcMain.handle(DESKTOP_IPC.connectAgents, (event, rawAgentTypes: unknown) =>
		safeDesktopAction(event, "connect the selected Agents", async () => {
			return cli.connectAgents(readAgentTypes(rawAgentTypes));
		}),
	);
}

async function safeDesktopAction<T>(
	event: IpcMainInvokeEvent,
	label: string,
	action: () => Promise<T>,
): Promise<T> {
	try {
		assertTrustedSender(event);
		return await action();
	} catch (error) {
		console.error(`Could not ${label}`, error);
		throw new Error(`Could not ${label}. Check your connection and try again.`);
	}
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
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

async function createMainWindow(): Promise<void> {
	const preload = join(fileURLToPath(new URL(".", import.meta.url)), "preload.cjs");
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
		if (new URL(url).origin !== trustedOrigin) {
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
	window.once("ready-to-show", () => window.show());
	window.on("closed", () => {
		if (mainWindow === window) mainWindow = null;
	});

	await window.loadURL(webUrl);
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
				click: () => {
					showMainWindow();
					mainWindow?.webContents.send(DESKTOP_IPC.openConnectWizard);
				},
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
	tray.on("click", showMainWindow);
}

function showMainWindow(): void {
	if (!mainWindow) {
		void createMainWindow();
		return;
	}
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}

function desktopWebUrl(): string {
	const raw = process.env.CLAWDI_DESKTOP_WEB_URL?.trim() || DEFAULT_WEB_URL;
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

function desktopIcon() {
	const path = app.isPackaged
		? join(process.resourcesPath, "clawdi-logo.png")
		: join(app.getAppPath(), "..", "web", "public", "clawdi-logo-transparent.png");
	return nativeImage.createFromPath(path);
}

function isSafeExternalUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return (
			(url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
		);
	} catch {
		return false;
	}
}

interface OAuthCallbackReceiver {
	callback: Promise<string>;
	close(): Promise<void>;
}

async function createOAuthCallbackReceiver(
	redirectUri: string,
	expiresAt: string,
): Promise<OAuthCallbackReceiver> {
	const redirect = new URL(redirectUri);
	if (
		redirect.protocol !== "http:" ||
		(redirect.hostname !== "127.0.0.1" && redirect.hostname !== "localhost") ||
		!redirect.port ||
		redirect.pathname !== "/oauth/callback"
	) {
		throw new Error("Clawdi returned an unsupported browser callback.");
	}
	const port = Number(redirect.port);
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
		response.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
		});
		response.end(
			"<!doctype html><meta charset=utf-8><title>Clawdi</title>" +
				"<body style='font:16px system-ui;padding:48px'>Sign-in complete. Return to Clawdi.</body>",
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
