"use client";

import { useRouter } from "@tanstack/react-router";
import { HeaderWalletBalanceControl } from "@/components/header-wallet-balance";
import { formatUsdExact } from "@/hosted/billing/format";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";

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

export function GlobalWalletBalance() {
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

export default GlobalWalletBalance;
