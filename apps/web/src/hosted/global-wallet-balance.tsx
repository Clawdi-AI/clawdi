"use client";

import { useRouter } from "@tanstack/react-router";
import { WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsdExact } from "@/hosted/billing/format";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { useHostedDeploymentInventory } from "@/hosted/use-hosted-deployment-inventory";
import { useHostedProductAccess } from "@/lib/hosted-product-access";

export function hostedWalletBalanceApplicable({
	canCreateCloudAgents,
	existingCloudDeploymentCount,
}: {
	canCreateCloudAgents: boolean;
	existingCloudDeploymentCount: number;
}): boolean {
	return canCreateCloudAgents || existingCloudDeploymentCount > 0;
}

function WalletBalanceEntry({
	label,
	children,
	onOpenWallet,
}: {
	label: string;
	children?: React.ReactNode;
	onOpenWallet?: () => void;
}) {
	return (
		<Button
			type="button"
			data-hosted="true"
			aria-label={label}
			onClick={onOpenWallet}
			variant="ghost"
			size="sm"
			data-testid="global-wallet-balance"
			className="max-w-40 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
		>
			<WalletCards className="size-4" />
			<span className="hidden sm:inline">Wallet</span>
			{children}
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
		return (
			<WalletBalanceEntry
				label="Wallet balance loading. Open Wallet settings"
				onOpenWallet={onOpenWallet}
			>
				<Skeleton aria-hidden="true" className="h-3.5 w-12" />
			</WalletBalanceEntry>
		);
	}

	const formattedBalance = state === "ready" && balanceUsd ? formatUsdExact(balanceUsd) : null;
	if (!formattedBalance || formattedBalance === "—") {
		return (
			<WalletBalanceEntry
				label="Wallet balance unavailable. Open Wallet settings"
				onOpenWallet={onOpenWallet}
			/>
		);
	}

	return (
		<WalletBalanceEntry
			label={`Wallet balance ${formattedBalance}. Open Wallet settings`}
			onOpenWallet={onOpenWallet}
		>
			<span className="font-medium text-foreground tabular-nums">{formattedBalance}</span>
		</WalletBalanceEntry>
	);
}

export function GlobalWalletBalance() {
	const router = useRouter();
	const hostedAccess = useHostedProductAccess();
	const cloudInventory = useHostedDeploymentInventory();
	const billingApplies = hostedWalletBalanceApplicable({
		canCreateCloudAgents: hostedAccess.canCreateCloudAgents,
		existingCloudDeploymentCount: cloudInventory.deployments?.length ?? 0,
	});
	const wallet = useWalletSnapshot({ enabled: billingApplies });

	if (!billingApplies) return null;
	const openWallet = () => {
		void router.navigate({
			to: ".",
			search: (current) => ({ ...current, settings: "billing-wallet" }),
			hash: true,
			replace: true,
			resetScroll: false,
		});
	};

	if (wallet.isLoading) {
		return <GlobalWalletBalanceView state="loading" onOpenWallet={openWallet} />;
	}
	if (!wallet.data) {
		return <GlobalWalletBalanceView state="unavailable" onOpenWallet={openWallet} />;
	}
	return (
		<GlobalWalletBalanceView
			state="ready"
			balanceUsd={wallet.data.balance_usd}
			onOpenWallet={openWallet}
		/>
	);
}

export default GlobalWalletBalance;
