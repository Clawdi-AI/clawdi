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
	paymentRequired:
		"Starting requires a server-approved subscription or payment action. No payment is made by these controls.",
	uncertain:
		"The operation may already have been accepted. Keep this screen open and retry its exact request to recover. Do not issue a replacement action from another device. If you leave, refresh status before making another change.",
	retry: "Retry original operation",
	conflict:
		"The server rejected the first request because the Agent version changed. Refresh and explicitly review a new change; no automatic overwrite occurs.",
	review: "Discard rejected request and review again",
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
