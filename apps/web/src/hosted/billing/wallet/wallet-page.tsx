"use client";

import { CreditCard, Wallet as WalletIcon } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { LowBalanceBanner } from "@/hosted/billing/components/low-balance-banner";
import {
	BillingEmpty,
	BillingError,
	WalletSkeleton,
} from "@/hosted/billing/components/state-views";
import { isWalletNotEnabledError } from "@/hosted/billing/errors";
import { useWallet, useWalletLedger } from "@/hosted/billing/hooks";
import { AutoReloadCard } from "@/hosted/billing/wallet/auto-reload-card";
import { BalanceCard } from "@/hosted/billing/wallet/balance-card";
import { LedgerTable } from "@/hosted/billing/wallet/ledger-table";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { LEDGER_MAX_ROWS, LEDGER_PAGE_SIZE } from "@/hosted/billing/wallet/wallet-constants";
import { X402Card } from "@/hosted/billing/wallet/x402-card";

const DESCRIPTION = "Your AI Credits balance, top-ups, and auto-reload.";

function scrollToAutoReload() {
	document.getElementById("auto-reload")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function WalletPage() {
	const wallet = useWallet();
	const [ledgerLimit, setLedgerLimit] = useState(LEDGER_PAGE_SIZE);
	const ledger = useWalletLedger(ledgerLimit);
	const [topUpOpen, setTopUpOpen] = useState(false);

	if (wallet.isLoading) {
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Wallet" description={DESCRIPTION} />
				<WalletSkeleton />
			</div>
		);
	}

	if (wallet.error || !wallet.data) {
		const legacy = isWalletNotEnabledError(wallet.error);
		return (
			<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
				<PageHeader title="Wallet" description={DESCRIPTION} />
				{legacy ? (
					<BillingEmpty
						icon={<WalletIcon />}
						title="Wallet billing isn’t enabled"
						description="This account uses the classic plan model. The AI Credits wallet is part of the new billing experience."
					/>
				) : (
					<BillingError error={wallet.error} onRetry={() => wallet.refetch()} />
				)}
			</div>
		);
	}

	const w = wallet.data;

	return (
		<div data-hosted="true" className="space-y-6 px-4 lg:px-6">
			<PageHeader
				title="Wallet"
				description={DESCRIPTION}
				actions={
					<Button onClick={() => setTopUpOpen(true)}>
						<CreditCard /> Top up
					</Button>
				}
			/>

			<LowBalanceBanner
				wallet={w}
				onTopUp={() => setTopUpOpen(true)}
				onAutoReload={scrollToAutoReload}
			/>

			<BalanceCard wallet={w} onTopUp={() => setTopUpOpen(true)} />

			<div id="auto-reload" className="grid gap-4 lg:grid-cols-2">
				<AutoReloadCard wallet={w} onTopUp={() => setTopUpOpen(true)} />
				<X402Card />
			</div>

			{ledger.error && !ledger.data ? (
				<BillingError
					error={ledger.error}
					title="Couldn’t load activity"
					onRetry={() => ledger.refetch()}
				/>
			) : (
				<LedgerTable
					entries={ledger.data?.items ?? []}
					pointsPerUsd={w.points_per_usd}
					isLoading={ledger.isLoading}
					hasMore={(ledger.data?.items.length ?? 0) >= ledgerLimit && ledgerLimit < LEDGER_MAX_ROWS}
					atCap={(ledger.data?.items.length ?? 0) >= LEDGER_MAX_ROWS}
					isFetchingMore={ledger.isFetching}
					onShowMore={() => setLedgerLimit((n) => Math.min(n + LEDGER_PAGE_SIZE, LEDGER_MAX_ROWS))}
				/>
			)}

			<TopUpDialog open={topUpOpen} onOpenChange={setTopUpOpen} wallet={w} />
		</div>
	);
}
