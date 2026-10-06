import { formatUsdExact } from "./billing-format";

export function headerWalletBalanceApplicable({
	canCreateCloudAgents,
	existingCloudDeploymentCount,
}: {
	canCreateCloudAgents: boolean;
	existingCloudDeploymentCount: number | null;
}): boolean {
	return canCreateCloudAgents || (existingCloudDeploymentCount ?? 0) > 0;
}

export function headerWalletBalancePresentation(
	state: "loading" | "ready" | "unavailable",
	balanceUsd?: string,
	interactive = false,
) {
	const formatted = state === "ready" && balanceUsd ? formatUsdExact(balanceUsd) : null;
	const displayedBalance = formatted && formatted !== "—" ? formatted : null;
	return headerWalletBalanceControlPresentation(state, displayedBalance, interactive);
}

export function headerWalletBalanceControlPresentation(
	state: "loading" | "ready" | "unavailable",
	formattedBalance?: string | null,
	interactive = false,
) {
	const displayedBalance = state === "ready" ? formattedBalance : null;
	const statusLabel = displayedBalance
		? `Wallet balance ${displayedBalance}`
		: state === "loading"
			? "Wallet balance loading"
			: "Wallet balance unavailable";
	return {
		displayedBalance,
		label: interactive ? `${statusLabel}. Open Wallet settings` : statusLabel,
	};
}
