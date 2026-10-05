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
	description: "This provider will be removed from your account and cannot be restored.",
	revocation:
		"Local access is removed immediately. Upstream ChatGPT revocation may finish asynchronously.",
	affected:
		"These agents will be set to Provider unset with no primary model. They will keep running, but model features will remain unavailable until reconfigured. There is no automatic fallback to Clawdi AI.",
	noAgents: "No hosted agents currently use this provider.",
	acknowledge: "I understand that affected agents will lose model access until reconfigured.",
	remove: "Remove provider",
	checking: "Checking affected agents...",
	cancel: "Cancel",
};
export const providerOAuthCopy = {
	code: "One-time code",
	open: "Open ChatGPT and enter code",
	expired: "This code expired. Start again for a new code.",
	failed: "Sign-in could not be completed. Start again and retry.",
	waiting: "Waiting for ChatGPT authorization…",
	restart: "Get a new code",
};

export function providerCredentialName(label: string) {
	return label === "API key" ? "API key" : label.toLowerCase();
}
export function providerCredentialLinkLabel(label: string, override?: string | null) {
	return override ?? `Get ${providerCredentialName(label)}`;
}
