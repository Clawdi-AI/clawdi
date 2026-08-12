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
			? `Your ${grantAmount} welcome balance is available in your Wallet.`
			: "Your welcome balance is available in your Wallet.";
	}
	if (grantPending) {
		if (grantCheckTimedOut) return "It hasn’t appeared yet. Refresh to check again.";
		const balance = grantAmount
			? `Your ${grantAmount} welcome balance is on the way.`
			: "Your welcome balance is on the way.";
		return balance;
	}
	return "Your Wallet is ready.";
}
