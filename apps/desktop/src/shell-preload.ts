import type { ClawdiDesktopShellBridge } from "@clawdi/shared/desktop";
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "./ipc";

const bridge: ClawdiDesktopShellBridge = {
	signIn: () => ipcRenderer.invoke(DESKTOP_IPC.signIn),
	signOut: () => ipcRenderer.invoke(DESKTOP_IPC.signOut),
	openFilesWindow: (url) => ipcRenderer.invoke(DESKTOP_IPC.openFilesWindow, url),
	openRuntimeWindow: (url) => ipcRenderer.invoke(DESKTOP_IPC.openRuntimeWindow, url),
	openTerminalWindow: (url) => ipcRenderer.invoke(DESKTOP_IPC.openTerminalWindow, url),
	openConnectWizard: () => ipcRenderer.invoke(DESKTOP_IPC.openConnectWizard),
	retryDashboard: () => ipcRenderer.invoke(DESKTOP_IPC.retryDashboard),
};

contextBridge.exposeInMainWorld("clawdiDesktop", bridge);
