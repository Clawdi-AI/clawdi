export function welcomeWalletDescription({
	grantApplied,
	grantPending,
	grantCheckTimedOut,
	grantAmount,
}: {
	grantApplied: boolean;
	grantPending: boolean;
	grantCheckTimedOut: boolean;
	grantAmount: string | null;
}): string {
	if (grantApplied) {
		return grantAmount
			? `Your ${grantAmount} welcome balance is available in your wallet.`
			: "Your welcome balance is available in your wallet.";
	}
	if (grantPending) {
		if (grantCheckTimedOut) return "It hasn’t appeared yet. Refresh to check again.";
		const balance = grantAmount
			? `Your ${grantAmount} welcome balance is on the way.`
			: "Your welcome balance is on the way.";
		return balance;
	}
	return "Your wallet is ready.";
}

type WelcomeWalletState = {
	grantApplied: boolean;
	grantPending: boolean;
	grantCheckTimedOut: boolean;
	grantAmount: string | null;
};

export function welcomeWalletTitle({
	grantApplied,
	grantPending,
	grantCheckTimedOut,
	grantAmount,
}: WelcomeWalletState): string {
	if (grantApplied) {
		return grantAmount
			? `You're all set — ${grantAmount} added to your wallet`
			: "You're all set — your welcome balance was added to your wallet";
	}
	if (grantPending) {
		return grantCheckTimedOut
			? "Your welcome balance is taking longer than expected"
			: "Adding your welcome balance…";
	}
	return "Welcome to Clawdi";
}

export const welcomeWalletCopy = {
	loading: "Loading welcome balance",
	loadError: "Couldn't load welcome balance",
	refresh: "Refresh balance",
} as const;

/** The welcome grant re-check cadence and how long to wait before offering a refresh. */
export const WELCOME_GRANT_RECHECK_INTERVAL_MS = 5_000;
export const WELCOME_GRANT_TIMEOUT_MS = 60_000;
