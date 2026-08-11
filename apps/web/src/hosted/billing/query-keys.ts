const subscriptionCreateQuotes = ["billing", "subscription-create-quote"] as const;
const ledgerRoot = ["billing", "ledger"] as const;
const billingHistoryRoot = ["billing", "history"] as const;
const usageRoot = ["billing", "usage"] as const;

export const billingKeys = {
	managedModelCatalog: ["billing", "managed-model-catalog"] as const,
	wallet: ["billing", "wallet"] as const,
	ledgerRoot,
	ledger: (limit: number) => [...ledgerRoot, limit] as const,
	ledgerPages: (limit: number) => [...ledgerRoot, "pages", limit] as const,
	subscriptionCreateQuotes,
	subscriptionCreateQuote: (planSlug: string, billingTermMonths: number, fundingSource: string) =>
		[...subscriptionCreateQuotes, planSlug, billingTermMonths, fundingSource] as const,
	billingHistoryRoot,
	billingHistory: (limit: number) => [...billingHistoryRoot, limit] as const,
	plans: ["billing", "plans"] as const,
	subscriptions: ["billing", "subscriptions"] as const,
	deployments: ["billing", "deployments"] as const,
	workspaceSkills: (deploymentId: string) =>
		["hosted", "deployments", deploymentId, "skills"] as const,
	legacyAgentEnvironments: ["billing", "legacy-agent-environments"] as const,
	me: ["billing", "me"] as const,
	usage: (days: number | null, agentId: string | null = null) =>
		[...usageRoot, days, agentId] as const,
};
