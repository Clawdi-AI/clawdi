import type { ClawdiDesktopBridge } from "@clawdi/shared/desktop";
import { contextBridge, ipcRenderer } from "electron";
import { DASHBOARD_ORIGIN } from "./dashboard-window";
import { DESKTOP_IPC } from "./ipc";

const bridge: ClawdiDesktopBridge = {
	apiVersion: 2,
	signOut: () => ipcRenderer.invoke(DESKTOP_IPC.signOut),
	openConnectWizard: () => ipcRenderer.invoke(DESKTOP_IPC.openConnectWizard),
	createDashboardSession: () => ipcRenderer.invoke(DESKTOP_IPC.createDashboardSession),
	openExternal: (url) => ipcRenderer.invoke(DESKTOP_IPC.openExternal, url),
};

if (process.isMainFrame && location.origin === DASHBOARD_ORIGIN) {
	contextBridge.exposeInMainWorld("clawdiDesktop", bridge);
}
