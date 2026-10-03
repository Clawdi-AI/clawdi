export const creationEn = {
	title: "New Cloud Agent",
	unavailable: "Cloud creation is not configured.",
	name: "Agent name",
	runtime: "Runtime",
	language: "Language",
	timezone: "Timezone (IANA, optional)",
	managed: "Managed AI",
	unmanaged: "Configure AI after creation",
	model: "Managed model",
	chooseModel: "Choose a catalog model",
	compute: "Independent compute subscription for this Agent",
	basic: "Basic",
	performance: "Performance",
	selectionNotice:
		"Choose the compute plan for this Agent. The server selects a matching unbound entitlement; this does not select or purchase a specific subscription.",
	included: "Server-reported available Basic slots",
	reusable: "Existing reusable subscriptions",
	pending:
		"New paid subscriptions and store purchases are not connected. You can use existing unbound Basic or Performance entitlements without buying new compute.",
	quote: "Request price preview",
	quoteNotice:
		"A preview may initialize your billing profile. It does not pay an invoice or debit your wallet.",
	preview: "Invoice preview, not a payment",
	confirm:
		"I confirm the server may assign an existing entitlement for the selected plan, including an already-paid unbound subscription. This action does not purchase new compute.",
	create: "Create with server-selected entitlement",
	blocked:
		"Creation requires the selected plan in the catalog and matching reusable inventory (or an available included Basic slot). Load more subscriptions if needed. The server verifies permission when you submit.",
	monthly: "Monthly preview",
	months: "months",
	annual: "Annual preview",
	invalidRuntime: "Choose a supported runtime.",
	invalidCompute: "Choose an available compute plan.",
	invalidName: "Enter an Agent name with 1–64 characters.",
	invalidLanguage: "Choose a supported language.",
	invalidTimezone: "Use a valid IANA timezone or leave it empty.",
	invalidModel: "Choose a model from the current managed catalog.",
	recover: "Check saved creation request",
	retry: "Retry the same saved request",
	clear: "Finish recovery and start a new draft",
	discard: "Discard this unsubmitted or rejected draft",
	notAdmitted:
		"The server rejected this request before admission. You may explicitly discard it and edit a new draft.",
	saved:
		"A saved request exists. Check its status before retrying. No request is replayed automatically.",
	wait: "The server has not projected a deployment yet. Check again later.",
	failed:
		"The saved creation request is terminal. Review its status before starting another request.",
	error:
		"The action could not be completed. Your saved request is preserved; check its status before retrying.",
	storageError:
		"Saved creation data is unavailable or invalid. Creation is paused to avoid duplicating a request.",
	refresh: "Refresh server eligibility",
	validate: "Review configuration",
	valid: "Configuration is valid.",
} as const;
