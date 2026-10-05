export const subscriptionSourceCopy = {
	includedTitle: "Basic compute",
	includedDescription: "Use your included Basic entitlement.",
	included: "Included",
	dueNow: "$0 due now",
	newTitle: "New paid subscription",
	newDescription: "Choose a plan, billing term, and payment source.",
} as const;

export const deployFormCopy = {
	name: "Name in Clawdi",
	timezone: "Timezone",
	deploy: "Deploy",
	chooseSource: "Choose a subscription source.",
	billingTerm: "Billing term",
	paymentMethod: "Payment method",
	cardTitle: "Card subscription",
	cardDescription: "Recurring subscription via Stripe. Manage or cancel anytime.",
	walletTitle: "Wallet balance",
	walletDescription: "Paid upfront from your Wallet balance. Renews from Wallet.",
} as const;

export function deployConfigurationSummary(runtime: string, ai: string, compute: string): string {
	return [runtime, ai, `${compute} compute`].filter(Boolean).join(" · ");
}

export function deployComputeResourceLabels(vcpu: number, ramGb: number, diskGb: number) {
	return [`${vcpu} vCPU`, `${ramGb} GB RAM`, `${diskGb} GB storage`];
}
