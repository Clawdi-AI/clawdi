import type { ClawdiDesktopShellBridge } from "@clawdi/shared/desktop";
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "./ipc";

const bridge: ClawdiDesktopShellBridge = {
	openConnectWizard: () => ipcRenderer.invoke(DESKTOP_IPC.openConnectWizard),
	retryDashboard: () => ipcRenderer.invoke(DESKTOP_IPC.retryDashboard),
};

contextBridge.exposeInMainWorld("clawdiDesktop", bridge);
