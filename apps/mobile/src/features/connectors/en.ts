export const connectorsEn = {
	title: "Connectors",
	description: "Connect external services and manage every connected account.",
	catalog: "Browse apps",
	accounts: "Connected accounts",
	search: "Search connectors",
	empty: "No connectors found.",
	noAccounts: "No accounts connected to this app.",
	alias: "Account name (optional)",
	saveAlias: "Save account name",
	connect: "Connect account",
	disconnect: "Disconnect account",
	disconnectWarning:
		"Agents will lose access to this connected account. You can connect it again later.",
	credentials:
		"Enter the credentials expected by this app. They are sent securely to the connector provider and cleared when you leave this screen.",
	ready: "This app needs no credentials and is ready to use.",
	unavailable:
		"This authentication method is unavailable. Additional server configuration may be required.",
	oauth:
		"Authorize in the system browser, then close it and return here. Refresh accounts to check the result; opening or closing the browser does not mean authorization succeeded.",
	refresh: "Refresh accounts",
	failed: "The action could not be completed. Refresh accounts before trying again.",
	tools: "Available tools",
	searchTools: "Search tools by name or description",
	noMatchingTools: "No tools match your search.",
	noTools: "No tools available.",
	deprecated: "Deprecated",
	required: "Required",
	active: "Tool access enabled",
	inactive: "Tool access unavailable",
} as const;
