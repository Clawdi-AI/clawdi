import { cleanWalletStripeReturnUrl } from "@/hosted/billing/wallet/stripe-return";
import { agentRouteQueryString } from "@/lib/agent-routes";

export type PaymentOutcome = "succeeded" | "processing";

export function paymentOutcomeForStatus(status: string | undefined): PaymentOutcome | null {
	if (status === "succeeded") return "succeeded";
	if (status === "processing" || status === "requires_capture") return "processing";
	return null;
}

export function buildSubscriptionPaymentReturnUrl(
	currentHref: string,
	deploymentId: string,
): string {
	const url = new URL(cleanWalletStripeReturnUrl(currentHref));
	for (const key of [
		"checkout",
		"checkout_session_id",
		"mockCheckout",
		"session_id",
		"upgrade_deployment_id",
	]) {
		url.searchParams.delete(key);
	}
	if (url.pathname.startsWith("/agents/")) {
		url.search = agentRouteQueryString(url.search);
	}
	url.searchParams.set("deployment_id", deploymentId);
	return url.toString();
}
