import type { QueryClient } from "@tanstack/react-query";
import type { WalletTopupResult } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";

type TopupToast = (message: string, options: { description: string }) => void;

export type TopupCompletionStatus = "succeeded" | "processing";

export interface TopupCompletionControls {
	queryClient: QueryClient;
	resetAttempt: () => void;
	closeDialog: () => void;
	toastSuccess: TopupToast;
}

export interface TopupStartResultControls extends TopupCompletionControls {
	startPayment: (clientSecret: string) => void;
	toastError: TopupToast;
}

export function invalidateWalletActivity(queryClient: QueryClient): void {
	queryClient.invalidateQueries({ queryKey: billingKeys.wallet });
	queryClient.invalidateQueries({ queryKey: ["billing", "ledger"] });
}

export function completeTopup(
	status: TopupCompletionStatus,
	controls: TopupCompletionControls,
): void {
	invalidateWalletActivity(controls.queryClient);
	controls.resetAttempt();
	if (status === "succeeded") {
		controls.toastSuccess("Top-up complete", {
			description: "Your credits will appear in a moment.",
		});
	} else {
		controls.toastSuccess("Top-up processing", {
			description: "We'll credit your wallet once the payment settles.",
		});
	}
	controls.closeDialog();
}

export function handleTopupStartResult(
	result: WalletTopupResult,
	controls: TopupStartResultControls,
): void {
	// Only the PaymentIntent STATUS decides success. The backend includes
	// `credits_added` (the credits this top-up WILL add) on every response —
	// including `requires_payment_method` — so treating its presence as success
	// closed the dialog before the card form ever showed and the top-up never
	// charged.
	if (result.status === "succeeded") {
		completeTopup("succeeded", controls);
		return;
	}
	if (result.flow_type === "payment_intent" && result.client_secret) {
		controls.startPayment(result.client_secret);
		return;
	}
	if (isProcessingTopupStatus(result.status)) {
		completeTopup("processing", controls);
		return;
	}
	controls.toastError("Couldn't start top-up", {
		description: "No payment was returned. Please try again.",
	});
}

function isProcessingTopupStatus(status: string): boolean {
	return status === "processing" || status === "pending" || status === "requires_capture";
}
