export const billingKeys = {
	wallet: ["billing", "wallet"] as const,
	ledger: (limit: number) => ["billing", "ledger", limit] as const,
	billingHistory: (limit: number) => ["billing", "history", limit] as const,
	plans: ["billing", "plans"] as const,
	deployments: ["billing", "deployments"] as const,
	legacyAgentEnvironments: ["billing", "legacy-agent-environments"] as const,
	me: ["billing", "me"] as const,
	usage: ["billing", "usage"] as const,
};
