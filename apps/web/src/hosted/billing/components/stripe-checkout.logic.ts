import type { CheckoutRequest, CheckoutResult, HostedDeployment } from "@/hosted/billing/contracts";

export const CHECKOUT_ELEMENTS_UI_MODE = "custom";

export function checkoutRedirectUrl(result: CheckoutResult): string | null {
	return result.action_url || result.checkout_url || null;
}

export function hasCheckoutClientSecret(
	result: CheckoutResult,
): result is CheckoutResult & { client_secret: string } {
	return typeof result.client_secret === "string" && result.client_secret.length > 0;
}

export function buildHostedCheckoutFallbackRequest(request: CheckoutRequest): CheckoutRequest {
	return { ...request, ui_mode: "hosted" };
}

export function findNewDeploymentId(
	previousDeploymentIds: readonly string[],
	deployments: readonly HostedDeployment[] | undefined,
): string | null {
	if (!deployments?.length) return null;
	const previousIds = new Set(previousDeploymentIds);
	const created = deployments.find((deployment) => !previousIds.has(deployment.id));
	return created?.id ?? null;
}
