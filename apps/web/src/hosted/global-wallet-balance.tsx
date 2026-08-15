"use client";

import { useRouter } from "@tanstack/react-router";
import { WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsdExact } from "@/hosted/billing/format";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { useProductAccess } from "@/lib/product-access";

export function headerWalletBalanceApplicable({
	canCreateCloudAgents,
	existingCloudDeploymentCount,
}: {
	canCreateCloudAgents: boolean;
	existingCloudDeploymentCount: number | null;
}): boolean {
	return canCreateCloudAgents || (existingCloudDeploymentCount ?? 0) > 0;
}

function HeaderWalletBalanceControl({
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

export function GlobalWalletBalanceView({
	state,
	balanceUsd,
	onOpenWallet,
}: {
	state: "loading" | "ready" | "unavailable";
	balanceUsd?: string;
	onOpenWallet?: () => void;
}) {
	if (state === "loading") {
		return <HeaderWalletBalanceControl state="loading" onOpenWallet={onOpenWallet} />;
	}

	const formattedBalance = state === "ready" && balanceUsd ? formatUsdExact(balanceUsd) : null;
	if (!formattedBalance || formattedBalance === "—") {
		return <HeaderWalletBalanceControl state="unavailable" onOpenWallet={onOpenWallet} />;
	}

	return (
		<HeaderWalletBalanceControl
			state="ready"
			formattedBalance={formattedBalance}
			onOpenWallet={onOpenWallet}
		/>
	);
}

function ApplicableGlobalWalletBalance() {
	const router = useRouter();
	const wallet = useWalletSnapshot();
	const openWallet = () => {
		void router.navigate({
			to: ".",
			search: (current) => ({ ...current, settings: "billing-wallet" }),
			hash: true,
			replace: true,
			resetScroll: false,
		});
	};

	return (
		<div data-hosted="true" className="contents">
			{wallet.isLoading ? (
				<GlobalWalletBalanceView state="loading" onOpenWallet={openWallet} />
			) : wallet.data ? (
				<GlobalWalletBalanceView
					state="ready"
					balanceUsd={wallet.data.balance_usd}
					onOpenWallet={openWallet}
				/>
			) : (
				<GlobalWalletBalanceView state="unavailable" onOpenWallet={openWallet} />
			)}
		</div>
	);
}

export function GlobalWalletBalance({
	existingCloudDeploymentCount,
}: {
	existingCloudDeploymentCount: number | null;
}) {
	const access = useProductAccess();
	const applicable = headerWalletBalanceApplicable({
		canCreateCloudAgents: access.canCreateCloudAgents,
		existingCloudDeploymentCount,
	});

	return (
		<div data-hosted="true" className="contents">
			{applicable ? <ApplicableGlobalWalletBalance /> : null}
		</div>
	);
}

export default GlobalWalletBalance;
