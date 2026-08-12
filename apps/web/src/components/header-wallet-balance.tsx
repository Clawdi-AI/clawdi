import { WalletCards } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function HeaderWalletBalanceSlot({ children }: { children?: ReactNode }) {
	return (
		<div
			data-hosted="true"
			data-testid="global-wallet-balance-slot"
			className="flex h-8 w-20 shrink-0 items-stretch sm:w-24"
		>
			{children}
		</div>
	);
}

export function headerWalletBalanceApplicable({
	canCreateCloudAgents,
	existingCloudDeploymentCount,
}: {
	canCreateCloudAgents: boolean;
	existingCloudDeploymentCount: number | null;
}): boolean {
	return canCreateCloudAgents || (existingCloudDeploymentCount ?? 0) > 0;
}

export function HeaderWalletBalanceControl({
	state,
	formattedBalance,
	onOpenWallet,
}: {
	state: "loading" | "ready" | "unavailable";
	formattedBalance?: string | null;
	onOpenWallet?: () => void;
}) {
	const displayedBalance = state === "ready" ? formattedBalance : null;
	const statusLabel = displayedBalance
		? `Wallet balance ${displayedBalance}`
		: state === "loading"
			? "Wallet balance loading"
			: "Wallet balance unavailable";
	const label = onOpenWallet ? `${statusLabel}. Open Wallet settings` : statusLabel;

	return (
		<Button
			type="button"
			data-hosted="true"
			aria-label={label}
			title={displayedBalance ? label : undefined}
			onClick={onOpenWallet}
			disabled={!onOpenWallet}
			variant="ghost"
			size="sm"
			data-testid="global-wallet-balance"
			className="w-full min-w-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
		>
			<WalletCards className="size-4" />
			{state === "loading" ? (
				<Skeleton aria-hidden="true" className="h-3.5 w-12" />
			) : displayedBalance ? (
				<span className="min-w-0 flex-1 truncate font-medium text-foreground tabular-nums">
					{displayedBalance}
				</span>
			) : null}
		</Button>
	);
}
