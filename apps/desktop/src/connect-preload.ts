import type {
	ClawdiDesktopConnectBridge,
	DesktopAgentConnection,
	DesktopAuthenticationProgress,
	DesktopConnectView,
} from "@clawdi/shared/desktop";
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "./ipc";

const bridge: ClawdiDesktopConnectBridge = {
	getBootstrapState: () => ipcRenderer.invoke(DESKTOP_IPC.bootstrapState),
	getInstallationState: () => ipcRenderer.invoke(DESKTOP_IPC.installationState),
	authenticate: () => ipcRenderer.invoke(DESKTOP_IPC.authenticate),
	onAuthenticationProgress: (listener) => {
		const handle = (_event: Electron.IpcRendererEvent, progress: DesktopAuthenticationProgress) =>
			listener(progress);
		ipcRenderer.on(DESKTOP_IPC.authenticationProgress, handle);
		return () => ipcRenderer.removeListener(DESKTOP_IPC.authenticationProgress, handle);
	},
	cancelAuthentication: () => ipcRenderer.invoke(DESKTOP_IPC.cancelAuthentication),
	reopenVerificationPage: () => ipcRenderer.invoke(DESKTOP_IPC.reopenVerificationPage),
	takeRequestedView: () => ipcRenderer.invoke(DESKTOP_IPC.takeRequestedView),
	onViewRequested: (listener) => {
		const handle = (_event: Electron.IpcRendererEvent, view: DesktopConnectView) => listener(view);
		ipcRenderer.on(DESKTOP_IPC.viewRequested, handle);
		return () => ipcRenderer.removeListener(DESKTOP_IPC.viewRequested, handle);
	},
	listExcludedProjects: () => ipcRenderer.invoke(DESKTOP_IPC.listExcludedProjects),
	addExcludedProject: () => ipcRenderer.invoke(DESKTOP_IPC.addExcludedProject),
	removeExcludedProject: (path: string) =>
		ipcRenderer.invoke(DESKTOP_IPC.removeExcludedProject, path),
	detectAgents: () => ipcRenderer.invoke(DESKTOP_IPC.detectAgents),
	listReconnectableAgents: () => ipcRenderer.invoke(DESKTOP_IPC.listReconnectableAgents),
	connectAgents: (connections: DesktopAgentConnection[]) =>
		ipcRenderer.invoke(DESKTOP_IPC.connectAgents, connections),
	moveToApplicationsFolder: () => ipcRenderer.invoke(DESKTOP_IPC.moveToApplicationsFolder),
	openDashboard: () => ipcRenderer.invoke(DESKTOP_IPC.openDashboard),
};

contextBridge.exposeInMainWorld("clawdiConnect", bridge);
