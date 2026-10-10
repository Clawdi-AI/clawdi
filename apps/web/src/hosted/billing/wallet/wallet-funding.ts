"use client";

import { HOSTED_WALLET_FUNDING_ERROR_COPY, hostedWalletFundingErrorKind } from "@clawdi/shared/api";
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

export const SUBSCRIPTION_WALLET_FUNDING_ERROR_COPY: WalletFundingErrorCopy =
	HOSTED_WALLET_FUNDING_ERROR_COPY.subscription;

export function decimalUsd(value: unknown): string | null {
	const parsed = canonicalDecimal(value);
	return parsed !== null && compareDecimals(parsed, "0") !== -1 ? parsed : null;
}

export function classifyWalletFundingError(error: unknown): WalletFundingError {
	const detail = billingErrorDetail(error);
	const kind = hostedWalletFundingErrorKind(detail?.code);
	if (kind === "insufficient_balance") {
		return { kind, shortfallUsd: decimalUsd(detail?.shortfall_usd) };
	}
	return { kind, shortfallUsd: null };
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
				toast.error(HOSTED_WALLET_FUNDING_ERROR_COPY.insufficientBalanceTitle, {
					description: errorCopy.insufficientBalance,
				});
			} else {
				toast.error(HOSTED_WALLET_FUNDING_ERROR_COPY.refundDebtTitle, {
					description: errorCopy.refundDebt,
				});
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
