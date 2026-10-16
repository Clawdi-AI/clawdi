export const connectorFormCopy = {
	renameTitle: "Rename account",
	rename: "Rename",
	name: "Name (optional)",
	namePlaceholder: "e.g. Work Gmail",
	nameHint:
		"Choose a unique name to help identify this account. Leave blank to use the account identity.",
	credentialsDescription:
		"Enter the credentials this app expects. They are stored in Composio and used when connector tools run.",
	credentialsEmpty:
		"This connector doesn't need any credentials configured here. Try OAuth from the connector page.",
	disconnectDescription:
		"All agents will lose access immediately. To restore access, sign in again.",
	disconnect: "Disconnect",
	cancel: "Cancel",
	connect: "Connect",
} as const;

export function connectorConnectTitle(name: string) {
	return `Connect ${name}`;
}
export function connectorDisconnectTitle(name: string) {
	return `Disconnect ${name}?`;
}

export const connectorDetailCopy = {
	ready: "Ready",
	connected: "Connected",
	noAccountRequired: "No account required",
	checkingAccounts: "Checking accounts",
	noAuthDescription: "This connector does not require an account connection.",
	noAuthEmpty: "No account connection is required.",
	loadConnectionsFailed: "Couldn't load connections",
	unsupportedTitle: "Connection unavailable",
	unsupported: "This connector uses an authentication method Clawdi does not support.",
	setupBlockedTitle: "Connector unavailable",
	setupBlocked: "Additional configuration is required. Contact support to continue.",
	noAccounts: "No connected accounts yet.",
} as const;

export function connectedAccountsLabel(count: number) {
	return `${count} connected`;
}

export function connectorsEmptyCopy(query: string) {
	return query
		? { title: "No matches", description: `Nothing matches "${query}".` }
		: {
				title: "No connectors available",
				description: "Connectors aren't available for this account yet.",
			};
}
