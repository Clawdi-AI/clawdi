/** Product copy from Web settings, reused by the native translation catalog. */
export const settingsCopy = {
	title: "Settings",
	general: "General",
	generalSummary: "Account and appearance",
	generalDescription: "Account and app preferences.",
	account: "Account",
	accountDescription: "Your Clawdi identity.",
	anonymous: "Anonymous",
	manageAccount: "Manage account",
	appearance: "Appearance",
	theme: "Theme",
	themeDescription: "Light, dark, or match your system.",
	light: "Light",
	dark: "Dark",
	system: "System",
	apiKeys: "API Keys",
	apiKeysSummary: "CLI and server tokens",
	apiKeysDescription: "Review and revoke bearer tokens created for servers and automation.",
	keysRetiredBefore:
		"API keys can no longer be created. To connect Clawdi on your computer or a server, run ",
	loginCommand: "clawdi auth login",
	keysRetiredBetween: " (use ",
	noOpenFlag: "--no-open",
	keysRetiredAfter: " on a server). Existing keys keep working until you revoke them.",
	created: "Created",
	lastUsed: "Last used",
	expires: "Expires",
	permissions: "Permissions",
	never: "Never",
	revoke: "Revoke",
	revokeTitle: "Revoke “{label}”?",
	revokeKey: "Revoke key",
	emptyKeys: "No active API keys",
	loadKeysFailed: "Couldn’t load API keys",
	keyRevoked: "API key revoked",
	revokeKeyFailed: "Couldn’t revoke API key",
	done: "Done",
	revokeDescription:
		"Requests using this key will stop working. This can’t be undone; reconnect the client with clawdi auth login.",
} as const;
/** Wallet transactions footer, e.g. "Showing 1 transaction". */
export function transactionsCountLabel(count: number): string {
	return `Showing ${count} ${count === 1 ? "transaction" : "transactions"}`;
}

export const billingCopy = {
	usedBy: "Used by",
	edit: "Edit",
	comingSoon: "Coming soon",
	autoReloadCardHint: "Auto-reload uses the card selected in Auto-reload below.",
	autoReloadThreshold: "When balance is below (USD)",
	autoReloadAmount: "Amount to add (USD)",
	autoReloadMonthlyLimit: "Monthly limit (USD)",
	sharedPricingUnavailable:
		"A shared Basic and Performance billing term is not currently available.",
	topUp: "Top up",
	plans: "Plans",
	plansDescription: "Compare Cloud Agent plans.",
	plansTermLabel: "Billing term for Basic and Performance",
	basic: "Basic",
	performance: "Performance",
	basicDescription: "Balanced capacity for everyday workloads.",
	performanceDescription: "Higher capacity for production workloads.",
	basicSubscription: "Basic subscription",
	performanceSubscription: "Performance subscription",
	pricingUnavailable: "Pricing unavailable",
	confidentialCompute: "Managed confidential compute · choose OpenClaw or Hermes",
	byok: "Bring your own API key (BYOK) · pay your provider directly",
	upTo: "Up to",
	storage: "storage",
	paymentMethods: "Payment methods",
	paymentMethodsDescription: "Cards saved to your billing account.",
	autoReload: "Auto-reload",
	autoReloadDescription: "Automatically add funds when your balance is low.",
	usdc: "USDC from a browser wallet",
	usdcUnavailable: "Browser-wallet USDC funding is not available for this account yet.",

	compute: "Compute",
	computeSummary: "Subscriptions and plans",
	computeDescription: "Subscriptions, plans, and account billing for Cloud Agents.",
	subscriptions: "Your subscriptions",
	subscriptionsDescription: "Manage every compute subscription in one place.",
	emptySubscriptions: "No compute subscriptions",
	emptySubscriptionsDescription: "Subscriptions will appear here when you start a Cloud Agent.",
	wallet: "Wallet",
	walletSummary: "Balance, top-ups, and payment methods",
	walletDescription: "Add funds and manage how your Clawdi usage is paid.",
	walletBalance: "Wallet balance",
	walletExplanation:
		"Pays for AI usage and wallet-funded compute subscriptions. Card-paid subscriptions do not use this balance.",
	transactions: "Transactions",
	transactionsDescription: "Top-ups, compute payments, credits, and adjustments.",
	emptyTransactions: "No transactions yet",
	emptyTransactionsDescription:
		"Top-ups, grants, compute charges, and other money movements will appear here.",
} as const;

/** The balance card's low-balance chip; wallet-funded compute also stops when the balance runs out. */
export function lowBalanceWarning(hasWalletCompute: boolean): string {
	return `Low — top up before ${hasWalletCompute ? "AI or compute is interrupted" : "Clawdi AI pauses"}`;
}

/** Wallet top-up results, shared by Web's toasts and the app's store top-up notices. */
export const walletTopupCopy = {
	accepted: {
		title: "Payment accepted",
		description: "We're confirming your wallet credit now.",
	},
	processing: {
		title: "Top-up processing",
		description: "We'll credit your wallet once the payment settles.",
	},
	notFinished: {
		title: "Top-up didn't finish",
		description: "No payment was collected. Start a new top-up and choose another method.",
	},
	unknown: {
		title: "Top-up status unknown",
		description:
			"We couldn't confirm whether Stripe finished the payment. We won't charge it again.",
	},
	credited: {
		title: "Wallet credited",
		description: "Your balance and Transactions now include the top-up.",
	},
	notConfirmed: {
		title: "Wallet credit not confirmed yet",
		description:
			"The wallet has not linked this payment to the displayed balance and Transactions yet.",
	},
} as const;
