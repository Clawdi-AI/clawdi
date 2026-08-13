"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { billingErrorDetail } from "@/hosted/billing/errors";
import { canonicalDecimal, compareDecimals } from "@/hosted/billing/format";
import { topUpAmountCentsForUsdShortfall } from "@/hosted/billing/wallet/top-up-dialog.logic";

export type WalletFundingError =
	| { kind: "insufficient_balance"; shortfallUsd: string | null }
	| { kind: "open_refund_debt"; shortfallUsd: null }
	| { kind: "other"; shortfallUsd: null };

export type WalletFundingErrorCopy = {
	insufficientBalance: string;
	refundDebt: string;
};

export const SUBSCRIPTION_WALLET_FUNDING_ERROR_COPY: WalletFundingErrorCopy = {
	insufficientBalance: "Top up the shortfall, then review a fresh wallet quote.",
	refundDebt: "Top up before starting this wallet subscription.",
};

export function decimalUsd(value: unknown): string | null {
	const parsed = canonicalDecimal(value);
	return parsed !== null && compareDecimals(parsed, "0") !== -1 ? parsed : null;
}

export function classifyWalletFundingError(error: unknown): WalletFundingError {
	const detail = billingErrorDetail(error);
	if (detail?.code === "insufficient_wallet_balance" || detail?.code === "insufficient_balance") {
		return { kind: "insufficient_balance", shortfallUsd: decimalUsd(detail.shortfall_usd) };
	}
	if (detail?.code === "open_refund_debt") {
		return { kind: "open_refund_debt", shortfallUsd: null };
	}
	return { kind: "other", shortfallUsd: null };
}

export function useWalletTopUpDialog(errorCopy: WalletFundingErrorCopy) {
	const [open, setOpen] = useState(false);
	const [initialAmountCents, setInitialAmountCents] = useState<number | null>(null);

	const reset = useCallback(() => {
		setOpen(false);
		setInitialAmountCents(null);
	}, []);
	const onOpenChange = useCallback(
		(nextOpen: boolean) => (nextOpen ? setOpen(true) : reset()),
		[reset],
	);
	const show = useCallback((shortfallUsd: string | null = null) => {
		setInitialAmountCents(topUpAmountCentsForUsdShortfall(shortfallUsd));
		setOpen(true);
	}, []);
	const handleFundingError = useCallback(
		(error: unknown): boolean => {
			const fundingError = classifyWalletFundingError(error);
			if (fundingError.kind === "other") return false;
			show(fundingError.shortfallUsd);
			if (fundingError.kind === "insufficient_balance") {
				toast.error("Not enough Wallet balance", {
					description: errorCopy.insufficientBalance,
				});
			} else {
				toast.error("Refund debt must be repaid", { description: errorCopy.refundDebt });
			}
			return true;
		},
		[errorCopy, show],
	);

	return {
		dialogProps: { open, initialAmountCents, onOpenChange },
		show,
		reset,
		handleFundingError,
	};
}
