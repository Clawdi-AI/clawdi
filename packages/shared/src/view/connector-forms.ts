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
