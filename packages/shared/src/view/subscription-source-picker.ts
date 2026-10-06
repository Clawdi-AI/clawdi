export const subscriptionSourceCopy = {
	includedTitle: "Basic plan",
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
	trialTitle: "Free trial",
	trialDescription: "No card required. Add a payment method to continue after your trial.",
	walletTitle: "Wallet balance",
	walletDescription: "Paid upfront from your wallet balance. Renews from wallet.",
} as const;

export function deployConfigurationSummary(runtime: string, ai: string, compute: string): string {
	return [runtime, ai, `${compute} plan`].filter(Boolean).join(" · ");
}

export function deployComputeResourceLabels(vcpu: number, ramGb: number, diskGb: number) {
	return [`${vcpu} vCPU`, `${ramGb} GB RAM`, `${diskGb} GB storage`];
}
