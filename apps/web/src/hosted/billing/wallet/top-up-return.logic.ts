import { SETTINGS_QUERY_KEY } from "@/lib/settings-routes";
import { cleanWalletTopupReturnUrl, WALLET_TOPUP_RETURN_PARAM } from "@/lib/wallet-topup-return";

export {
	bootstrapWalletTopupReturn,
	cleanMarkedWalletTopupReturnRequest,
	cleanWalletTopupReturnUrl,
	consumeWalletTopupReturn,
	coordinateWalletTopupReturn,
	readWalletTopupReturn,
} from "@/lib/wallet-topup-return";

export type WalletTopupReturnToastKind = "info" | "error";

export interface WalletTopupReturnToast {
	kind: WalletTopupReturnToastKind;
	title: string;
	description: string;
}

export const WALLET_TOPUP_ACCEPTED_TOAST = {
	title: "Payment accepted",
	description: "We're confirming your Wallet credit now.",
} as const;

export function buildWalletTopupReturnUrl(currentHref: string): string {
	const url = new URL(cleanWalletTopupReturnUrl(currentHref));
	url.searchParams.set(SETTINGS_QUERY_KEY, "billing-wallet");
	url.searchParams.set(WALLET_TOPUP_RETURN_PARAM, "1");
	return url.toString();
}

export function walletTopupReturnToast(status: string | null | undefined): WalletTopupReturnToast {
	if (status === "succeeded") {
		return {
			kind: "info",
			...WALLET_TOPUP_ACCEPTED_TOAST,
		};
	}
	if (status === "processing") {
		return {
			kind: "info",
			title: "Top-up processing",
			description: "We'll credit your wallet once the payment settles.",
		};
	}
	if (status === "requires_payment_method") {
		return {
			kind: "error",
			title: "Top-up didn't finish",
			description: "No payment was collected. Start a new top-up and choose another method.",
		};
	}
	return {
		kind: "info",
		title: "Top-up status unknown",
		description:
			"We couldn't confirm whether Stripe finished the payment. We won't charge it again.",
	};
}
