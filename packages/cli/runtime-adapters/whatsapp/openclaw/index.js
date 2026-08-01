import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
	id: "clawdi-whatsapp",
	name: "Clawdi WhatsApp",
	description: "Clawdi application-relay channel adapter",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "whatsappPlugin",
	},
	runtime: {
		specifier: "./api.js",
		exportName: "setWhatsAppRuntime",
	},
});
