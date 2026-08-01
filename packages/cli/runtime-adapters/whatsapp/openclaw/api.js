import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const runtimeStore = createPluginRuntimeStore({
	pluginId: "clawdi-whatsapp",
	errorMessage: "Clawdi WhatsApp runtime is not initialized",
});

export const setWhatsAppRuntime = runtimeStore.setRuntime;
export const getWhatsAppRuntime = runtimeStore.getRuntime;
export { whatsappPlugin } from "./plugin.js";
