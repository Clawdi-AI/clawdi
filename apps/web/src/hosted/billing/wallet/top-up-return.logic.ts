import { SETTINGS_QUERY_KEY } from "@/lib/settings-routes";

export const WALLET_TOPUP_RETURN_PARAM = "topup_return";
export const STRIPE_PAYMENT_INTENT_PARAM = "payment_intent";
export const STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM = "payment_intent_client_secret";
export const STRIPE_REDIRECT_STATUS_PARAM = "redirect_status";

export type WalletTopupReturnToastKind = "success" | "info" | "error";

export interface WalletTopupReturnState {
	clientSecret: string;
}

export interface WalletTopupReturnToast {
	kind: WalletTopupReturnToastKind;
	title: string;
	description: string;
}

export function buildWalletTopupReturnUrl(currentHref: string): string {
	const url = new URL(currentHref);
	url.searchParams.set(SETTINGS_QUERY_KEY, "billing-wallet");
	url.searchParams.set(WALLET_TOPUP_RETURN_PARAM, "1");
	return url.toString();
}

export function readWalletTopupReturn(search: string): WalletTopupReturnState | null {
	const params = new URLSearchParams(search);
	if (params.get(WALLET_TOPUP_RETURN_PARAM) !== "1") return null;
	const clientSecret = params.get(STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM);
	if (!clientSecret) return null;
	return { clientSecret };
}

export function cleanWalletTopupReturnUrl(currentHref: string): string {
	const url = new URL(currentHref);
	url.searchParams.delete(WALLET_TOPUP_RETURN_PARAM);
	url.searchParams.delete(STRIPE_PAYMENT_INTENT_PARAM);
	url.searchParams.delete(STRIPE_PAYMENT_INTENT_CLIENT_SECRET_PARAM);
	url.searchParams.delete(STRIPE_REDIRECT_STATUS_PARAM);
	return url.toString();
}

export function walletTopupReturnToast(status: string | null | undefined): WalletTopupReturnToast {
	if (status === "succeeded") {
		return {
			kind: "success",
			title: "Top-up complete",
			description: "Your credits will appear in a moment.",
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
		title: "Top-up status refreshed",
		description: "We'll update your wallet when Stripe reports the final status.",
	};
}
