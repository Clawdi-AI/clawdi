import type { ClawdiDesktopBridge, DesktopAgentType } from "@clawdi/shared/desktop";
import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_IPC } from "./ipc";

const bridge: ClawdiDesktopBridge = {
	getBootstrapState: () => ipcRenderer.invoke(DESKTOP_IPC.bootstrapState),
	authenticate: () => ipcRenderer.invoke(DESKTOP_IPC.authenticate),
	detectAgents: () => ipcRenderer.invoke(DESKTOP_IPC.detectAgents),
	connectAgents: (agentTypes: DesktopAgentType[]) =>
		ipcRenderer.invoke(DESKTOP_IPC.connectAgents, agentTypes),
	onOpenConnectWizard: (listener: () => void) => {
		const wrapped = () => listener();
		ipcRenderer.on(DESKTOP_IPC.openConnectWizard, wrapped);
		return () => ipcRenderer.removeListener(DESKTOP_IPC.openConnectWizard, wrapped);
	},
};

contextBridge.exposeInMainWorld("clawdiDesktop", bridge);
