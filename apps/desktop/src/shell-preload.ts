import type { ClawdiDesktopShellBridge, DesktopAgentType } from "@clawdi/shared/desktop";
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "./ipc";

const bridge: ClawdiDesktopShellBridge = {
	getDashboardState: () => ipcRenderer.invoke(DESKTOP_IPC.dashboardState),
	readLocalSession: (agent: DesktopAgentType, sessionId: string) =>
		ipcRenderer.invoke(DESKTOP_IPC.readLocalSession, agent, sessionId),
	openConnectWizard: () => ipcRenderer.invoke(DESKTOP_IPC.openConnectWizard),
};

contextBridge.exposeInMainWorld("clawdiDesktop", bridge);
