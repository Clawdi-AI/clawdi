import type { ClawdiDesktopConnectBridge, DesktopAgentType } from "@clawdi/shared/desktop";
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "./ipc";

const bridge: ClawdiDesktopConnectBridge = {
	getBootstrapState: () => ipcRenderer.invoke(DESKTOP_IPC.bootstrapState),
	authenticate: () => ipcRenderer.invoke(DESKTOP_IPC.authenticate),
	detectAgents: () => ipcRenderer.invoke(DESKTOP_IPC.detectAgents),
	connectAgents: (agentTypes: DesktopAgentType[]) =>
		ipcRenderer.invoke(DESKTOP_IPC.connectAgents, agentTypes),
	openDashboard: () => ipcRenderer.invoke(DESKTOP_IPC.openDashboard),
};

contextBridge.exposeInMainWorld("clawdiConnect", bridge);
