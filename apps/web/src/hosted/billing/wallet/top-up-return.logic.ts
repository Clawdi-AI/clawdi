import { walletTopupCopy } from "@clawdi/shared/view";
import {
	buildWalletStripeReturnUrl,
	WALLET_PAYMENT_FLOW_PARAM,
	WALLET_PAYMENT_RETURN_PARAM,
} from "@/hosted/billing/wallet/stripe-return";
import { SETTINGS_QUERY_KEY } from "@/lib/settings-routes";

export type WalletTopupReturnToastKind = "info" | "error";

export interface WalletTopupReturnToast {
	kind: WalletTopupReturnToastKind;
	title: string;
	description: string;
}

export function buildWalletAutoReloadReturnUrl(currentHref: string): string {
	return buildWalletStripeReturnUrl(currentHref, [
		[SETTINGS_QUERY_KEY, "billing-wallet"],
		[WALLET_PAYMENT_RETURN_PARAM, "1"],
		[WALLET_PAYMENT_FLOW_PARAM, "auto_reload"],
	]);
}

export function walletTopupReturnToast(status: string | null | undefined): WalletTopupReturnToast {
	if (status === "succeeded") {
		return { kind: "info", ...walletTopupCopy.accepted };
	}
	if (status === "processing") {
		return { kind: "info", ...walletTopupCopy.processing };
	}
	if (status === "requires_payment_method") {
		return { kind: "error", ...walletTopupCopy.notFinished };
	}
	return { kind: "info", ...walletTopupCopy.unknown };
}
