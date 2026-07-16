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
	const url = new URL(currentHref);
	for (const key of [
		"checkout",
		"checkout_session_id",
		"mockCheckout",
		"session_id",
		"topup_return",
		"upgrade_deployment_id",
	]) {
		url.searchParams.delete(key);
	}
	url.searchParams.set("deployment_id", deploymentId);
	return url.toString();
}
