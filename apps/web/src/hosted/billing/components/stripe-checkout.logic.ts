import type { CheckoutOperationResult } from "@/hosted/billing/billing-client";

export { checkoutSessionClientSecret } from "@/hosted/billing/stripe-client-secret";

export const CHECKOUT_ELEMENTS_UI_MODE = "custom";
export const HOSTED_CHECKOUT_UI_MODE = "hosted";

export function checkoutUiModeForPublishableKey(
	publishableKey: string | undefined,
): typeof CHECKOUT_ELEMENTS_UI_MODE | typeof HOSTED_CHECKOUT_UI_MODE {
	return publishableKey ? CHECKOUT_ELEMENTS_UI_MODE : HOSTED_CHECKOUT_UI_MODE;
}

export function checkoutRedirectUrl(result: CheckoutOperationResult): string | null {
	return result.flow_type === "checkout_session"
		? result.action_url || result.checkout_url || null
		: result.checkout_url || null;
}
