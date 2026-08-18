import { cleanWalletStripeReturnUrl } from "@/hosted/billing/wallet/stripe-return";

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
	url.search = "";
	url.searchParams.set("settings", "billing-plan");
	url.searchParams.set("deployment_id", deploymentId);
	return url.toString();
}
