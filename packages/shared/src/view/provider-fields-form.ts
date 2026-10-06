export const providerFieldsFormCopy = {
	name: "Name",
	chatGpt: "ChatGPT sign-in",
	subscriptionAccess: "Subscription access",
	reconnect: "Reconnect",
	continueChatGpt: "Continue to ChatGPT",
	apiFormat: "API format",
	endpoint: "Endpoint",
	endpointPlaceholder: "https://api.example.com/v1",
	keepCredential: "Leave blank to keep current credential",
	addTitle: "Add a provider",
	add: "Add provider",
	save: "Save settings",
	edit: "Edit",
	apiKey: "API key",
	apiKeyPlaceholder: "Enter API key",
} as const;

export const providerRemovalCopy = {
	impactError: "Couldn’t check affected agents",
	description: "This provider will be removed from your account and cannot be restored.",
	revocation:
		"Local access is removed immediately. Upstream ChatGPT revocation may finish asynchronously.",
	affected:
		"These agents will keep running with Provider unset, but model features stop until you choose a new provider. There's no fallback to Clawdi AI.",
	noAgents: "No Cloud Agents use this provider.",
	acknowledge: "I understand that affected agents will lose model access until reconfigured.",
	remove: "Remove provider",
	checking: "Checking affected agents…",
	cancel: "Cancel",
};
export const providerOAuthCopy = {
	code: "One-time code",
	open: "Open ChatGPT and enter code",
	expired: "This code expired. Start again for a new code.",
	failed: "Sign-in couldn't be completed. Start again and retry.",
	waiting: "Waiting for ChatGPT authorization…",
	restart: "Get a new code",
};

export function providerCredentialName(label: string) {
	return label === "API key" ? "API key" : label.toLowerCase();
}
export function providerCredentialLinkLabel(label: string, override?: string | null) {
	return override ?? `Get ${providerCredentialName(label)}`;
}
