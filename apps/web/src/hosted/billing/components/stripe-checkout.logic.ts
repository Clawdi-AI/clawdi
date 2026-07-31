import type { CheckoutResult, HostedDeployment } from "@/hosted/billing/contracts";

export const CHECKOUT_ELEMENTS_UI_MODE = "custom";
export const HOSTED_CHECKOUT_UI_MODE = "hosted";

export function checkoutUiModeForPublishableKey(
	publishableKey: string | undefined,
): typeof CHECKOUT_ELEMENTS_UI_MODE | typeof HOSTED_CHECKOUT_UI_MODE {
	return publishableKey ? CHECKOUT_ELEMENTS_UI_MODE : HOSTED_CHECKOUT_UI_MODE;
}

export function checkoutRedirectUrl(result: CheckoutResult): string | null {
	return result.action_url || result.checkout_url || null;
}

export function hasCheckoutClientSecret(
	result: CheckoutResult,
): result is CheckoutResult & { client_secret: string } {
	return typeof result.client_secret === "string" && result.client_secret.length > 0;
}

export function findNewDeploymentId(
	previousDeploymentIds: readonly string[],
	deployments: readonly HostedDeployment[] | undefined,
): string | null {
	if (!deployments?.length) return null;
	const previousIds = new Set(previousDeploymentIds);
	const created = deployments.find((deployment) => !previousIds.has(deployment.resource.id));
	return created?.resource.id ?? null;
}
