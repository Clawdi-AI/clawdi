export const runtimeEn = {
	title: "Agent runtime and settings",
	confirm: "Apply Agent change?",
	warning:
		"Changes may interrupt active work and channel connections. Stopping compute does not cancel its subscription. Resetting dashboard access invalidates existing browser access.",
	apply: "Apply confirmed change",
	start: "Start runtime",
	stop: "Stop runtime",
	restart: "Restart runtime",
	resetAccess: "Reset dashboard access",
	deleteAgent: "Delete Agent, keep subscription",
	deleteWarning:
		"This permanently deletes the Agent and its saved data. This cannot be undone. Any paid subscription is kept and may continue billing; manage it separately through its original purchase provider. Only confirm if you want to delete this Agent without cancelling its subscription.",
	deleteReported:
		"The server reports this Agent deleted for your account. Cleanup may still be in progress. This action did not request subscription cancellation.",
	paymentRequired:
		"Starting requires a server-approved subscription or payment action. No payment is made by these controls.",
	uncertain:
		"The operation may already have been accepted. Its original request is saved on this device for this account and Agent. Retry that exact request to recover, even after reopening the app. Do not issue a replacement action from another device.",
	prepared:
		"The confirmed request was saved before sending. Retry it or discard this unsent request.",
	storageError:
		"The saved operation could not be read. Runtime changes are disabled. Retry loading it; do not clear app data to bypass an uncertain operation.",
	reloadAttempt: "Reload saved operation",
	retry: "Retry original operation",
	conflict:
		"The server rejected the first request because the Agent version changed. Refresh and explicitly review a new change; no automatic overwrite occurs.",
	review: "Discard unsent or rejected request",
	failed:
		"The action was not confirmed. Refresh status and review permissions, provider readiness or the original request before retrying.",
	locale: "Language and timezone",
	default: "Agent default",
	timezone: "IANA timezone (for example America/Los_Angeles)",
	invalidLocale:
		"Choose a supported language and valid timezone, or leave them at the Agent default.",
	saveLocale: "Review language and timezone change",
	model: "AI provider and model",
	chooseProvider: "Choose a provider explicitly",
	chooseModel: "Choose a managed model",
	modelId: "Model ID",
	modelsInAgent:
		"This connection's models are configured inside the Agent. Applying it will not overwrite its model catalog.",
	unmanaged: "Configured inside Agent",
	unmanagedWarning:
		"This removes Clawdi's provider binding and keeps the Agent's own settings. It does not revoke the saved provider account.",
	providerConflict:
		"The Agent reported a provider configuration conflict. Its own settings may take precedence. Review the binding before changing it.",
	refreshProviders: "Refresh provider availability",
	saveModel: "Review provider binding change",
};
