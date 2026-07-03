"use client";

import { CreditCard } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Button } from "@/components/ui/button";
import { LowBalanceBanner } from "@/hosted/billing/components/low-balance-banner";
import { BillingError, WalletSkeleton } from "@/hosted/billing/components/state-views";
import { useWallet, useWalletLedger } from "@/hosted/billing/hooks";
import { AutoReloadCard } from "@/hosted/billing/wallet/auto-reload-card";
import { BalanceCard } from "@/hosted/billing/wallet/balance-card";
import { LedgerTable } from "@/hosted/billing/wallet/ledger-table";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { LEDGER_MAX_ROWS, LEDGER_PAGE_SIZE } from "@/hosted/billing/wallet/wallet-constants";
import { X402Card } from "@/hosted/billing/wallet/x402-card";
import { cn } from "@/lib/utils";

const DESCRIPTION = "Your AI Credits balance, top-ups, and auto-reload.";
const WALLET_PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.wide, "space-y-6 px-4 lg:px-6");

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
			<div data-hosted="true" className={WALLET_PAGE_CLASS}>
				<PageHeader title="Wallet" description={DESCRIPTION} />
				<WalletSkeleton />
			</div>
		);
	}

	if (wallet.error || !wallet.data) {
		return (
			<div data-hosted="true" className={WALLET_PAGE_CLASS}>
				<PageHeader title="Wallet" description={DESCRIPTION} />
				<BillingError error={wallet.error} onRetry={() => wallet.refetch()} />
			</div>
		);
	}

	const w = wallet.data;

	return (
		<div data-hosted="true" className={WALLET_PAGE_CLASS}>
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
