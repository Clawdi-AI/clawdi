"use client";

import { globalWalletBalanceClasses as styles } from "@clawdi/shared/ui";
import {
	headerWalletBalanceApplicable,
	headerWalletBalanceControlPresentation,
} from "@clawdi/shared/view";
import { useRouter } from "@tanstack/react-router";
import { WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsdExact } from "@/hosted/billing/format";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { useProductAccess } from "@/lib/product-access";

export { headerWalletBalanceApplicable } from "@clawdi/shared/view";

function HeaderWalletBalanceControl({
	state,
	formattedBalance,
	onOpenWallet,
}: {
	state: "loading" | "ready" | "unavailable";
	formattedBalance?: string | null;
	onOpenWallet?: () => void;
}) {
	const { displayedBalance, label } = headerWalletBalanceControlPresentation(
		state,
		formattedBalance,
		Boolean(onOpenWallet),
	);

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
			className={styles.control}
		>
			<WalletCards className={styles.icon} />
			{state === "loading" ? (
				<Skeleton aria-hidden="true" className={styles.skeleton} />
			) : displayedBalance ? (
				<span className={styles.balance}>{displayedBalance}</span>
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
