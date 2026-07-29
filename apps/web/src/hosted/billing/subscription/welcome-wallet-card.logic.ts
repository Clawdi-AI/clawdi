export function welcomeWalletDescription({
	grantApplied,
	grantPending,
	grantCheckTimedOut,
	grantAmount,
	showDeployAction,
}: {
	grantApplied: boolean;
	grantPending: boolean;
	grantCheckTimedOut: boolean;
	grantAmount: string | null;
	showDeployAction: boolean;
}): string {
	if (grantApplied) {
		if (!showDeployAction) {
			return grantAmount
				? `Your ${grantAmount} welcome balance is available in your Wallet.`
				: "Your welcome balance is available in your Wallet.";
		}
		return grantAmount
			? `Your free Basic compute is ready. Your ${grantAmount} welcome balance covers Managed AI first; after that, usage draws from your Wallet.`
			: "Your free Basic compute is ready. Managed AI usage draws from your Wallet.";
	}
	if (grantPending) {
		if (grantCheckTimedOut) return "It hasn’t appeared yet. Refresh to check again.";
		const balance = grantAmount
			? `Your ${grantAmount} welcome balance is on the way.`
			: "Your welcome balance is on the way.";
		return showDeployAction
			? `${balance} You can deploy now; it’ll be ready in a moment.`
			: balance;
	}
	return showDeployAction
		? "Your free Basic compute slot is ready. Deploy your first agent to get going."
		: "Your Wallet is ready.";
}
