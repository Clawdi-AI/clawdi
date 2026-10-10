import type { ClawdiDesktopBridge } from "@clawdi/shared/desktop";
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "./ipc";

const bridge: ClawdiDesktopBridge = {
	version: 1,
	signOut: () => ipcRenderer.invoke(DESKTOP_IPC.signOut),
	openConnector: () => ipcRenderer.send(DESKTOP_IPC.openConnector),
	createDashboardSession: () => ipcRenderer.invoke(DESKTOP_IPC.createDashboardSession),
	openInBrowser: (url) => ipcRenderer.send(DESKTOP_IPC.openInBrowser, url),
};

const origin = process.argv
	.find((argument) => argument.startsWith("--clawdi-dashboard-origin="))
	?.slice("--clawdi-dashboard-origin=".length);
if (process.isMainFrame && location.origin === origin) {
	contextBridge.exposeInMainWorld("clawdiDesktop", bridge);
}
