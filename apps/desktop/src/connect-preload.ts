import type { ClawdiDesktopConnectBridge, DesktopAgentConnection } from "@clawdi/shared/desktop";
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "./ipc";

const bridge: ClawdiDesktopConnectBridge = {
	getBootstrapState: () => ipcRenderer.invoke(DESKTOP_IPC.bootstrapState),
	getInstallationState: () => ipcRenderer.invoke(DESKTOP_IPC.installationState),
	authenticate: () => ipcRenderer.invoke(DESKTOP_IPC.authenticate),
	cancelAuthentication: () => ipcRenderer.invoke(DESKTOP_IPC.cancelAuthentication),
	detectAgents: () => ipcRenderer.invoke(DESKTOP_IPC.detectAgents),
	listReconnectableAgents: () => ipcRenderer.invoke(DESKTOP_IPC.listReconnectableAgents),
	connectAgents: (connections: DesktopAgentConnection[]) =>
		ipcRenderer.invoke(DESKTOP_IPC.connectAgents, connections),
	moveToApplicationsFolder: () => ipcRenderer.invoke(DESKTOP_IPC.moveToApplicationsFolder),
	openDashboard: () => ipcRenderer.invoke(DESKTOP_IPC.openDashboard),
};

contextBridge.exposeInMainWorld("clawdiConnect", bridge);
