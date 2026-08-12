"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useBillingClient } from "@/hosted/billing/billing-client";
import type {
	ComputeFixPaymentRequest,
	PortalRequest,
	WalletAutoReloadRequest,
	WalletTopupRequest,
} from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import {
	type SubscriptionCreateRequestView,
	subscriptionCreateOutcome,
	subscriptionCreateRequest,
} from "@/hosted/billing/subscription/subscription-create-adapter";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

function useInvalidateBillingAfterCheckout() {
	const queryClient = useQueryClient();
	return () => {
		queryClient.invalidateQueries({ queryKey: billingKeys.deployments });
		queryClient.invalidateQueries({ queryKey: billingKeys.wallet });
		queryClient.invalidateQueries({ queryKey: billingKeys.transactions });
		queryClient.invalidateQueries({ queryKey: ["get", "/v1/agents"] });
	};
}

export function useSensitiveTopUp() {
	const client = useBillingClient();
	return useSensitiveAction(
		({ body, idempotencyKey }: { body: WalletTopupRequest; idempotencyKey: string }) =>
			client.topUp(body, idempotencyKey),
	);
}

export function useSensitiveSetAutoReload() {
	const client = useBillingClient();
	return useSensitiveAction((body: WalletAutoReloadRequest) => client.setAutoReload(body));
}

export function useSensitiveCreateSubscription() {
	const client = useBillingClient();
	const invalidate = useInvalidateBillingAfterCheckout();
	return useSensitiveAction(async (request: SubscriptionCreateRequestView) => {
		const apiRequest = subscriptionCreateRequest(request);
		const result = subscriptionCreateOutcome(
			await client.checkout(apiRequest.body, apiRequest.idempotencyKey),
		);
		invalidate();
		return result;
	});
}

export function useSensitiveBillingPortal() {
	const client = useBillingClient();
	return useSensitiveAction((body: PortalRequest) => client.portal(body));
}

export function useSensitiveFixPayment() {
	const client = useBillingClient();
	return useSensitiveAction((body: ComputeFixPaymentRequest) => client.fixPayment(body));
}

export function useSensitiveWalletSnapshot() {
	const client = useBillingClient();
	return useSensitiveAction(() => client.getWallet());
}
