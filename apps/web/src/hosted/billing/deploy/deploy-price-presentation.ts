import { formatUsdExact } from "@/hosted/billing/format";
import type { WalletDebitSummary } from "@/hosted/billing/wallet/wallet-debit-summary";
import { walletDebitShortfallUsd } from "@/hosted/billing/wallet/wallet-debit-summary";

export {
	type CardTrialPricePresentation,
	type ComputePricePresentation,
	cardDeployAmountPresentation,
	cardTrialPricePresentation,
	computePricePresentation,
	type DeployAmountPresentation,
} from "@clawdi/shared/view";

import type { DeployAmountPresentation } from "@clawdi/shared/view";

export function walletDeployAmountPresentation({
	billingTermMonths,
	state,
	walletDebit,
}: {
	billingTermMonths: number;
	state: "loading" | "error" | "ready";
	walletDebit: WalletDebitSummary | null;
}): DeployAmountPresentation {
	if (state === "error") {
		return { amount: "Quote unavailable", caption: null, detail: null };
	}
	if (state === "loading" || !walletDebit) {
		return { amount: "Debit today: —", caption: "Getting quote…", detail: null };
	}

	const shortfallUsd = walletDebitShortfallUsd(walletDebit);
	return {
		amount: `Debit today: ${formatUsdExact(walletDebit.debitAmountUsd)}`,
		caption: `From Wallet · renews ${billingTermMonths === 12 ? "yearly" : "monthly"}`,
		detail:
			shortfallUsd === null
				? null
				: `Available ${formatUsdExact(walletDebit.balanceBeforeUsd)} · short ${formatUsdExact(shortfallUsd)}`,
	};
}
