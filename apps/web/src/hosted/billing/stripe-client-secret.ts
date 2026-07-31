import type { CheckoutOperationResult } from "@/hosted/billing/billing-client";
import type { WalletAutoReloadAction, WalletTopupResult } from "@/hosted/billing/contracts";

declare const checkoutSessionClientSecretBrand: unique symbol;
declare const paymentIntentClientSecretBrand: unique symbol;

type CheckoutSessionResult = Extract<CheckoutOperationResult, { flow_type: "checkout_session" }>;

export type CheckoutSessionClientSecret = NonNullable<CheckoutSessionResult["client_secret"]> & {
	readonly [checkoutSessionClientSecretBrand]: "CheckoutSessionClientSecret";
};

export type PaymentIntentClientSecret = (
	| NonNullable<WalletTopupResult["client_secret"]>
	| WalletAutoReloadAction["client_secret"]
) & {
	readonly [paymentIntentClientSecretBrand]: "PaymentIntentClientSecret";
};

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isCheckoutSessionClientSecret(value: unknown): value is CheckoutSessionClientSecret {
	return isNonEmptyString(value);
}

function isPaymentIntentClientSecret(value: unknown): value is PaymentIntentClientSecret {
	return isNonEmptyString(value);
}

export function checkoutSessionClientSecret(
	result: CheckoutOperationResult,
): CheckoutSessionClientSecret | null {
	if (
		result.flow_type !== "checkout_session" ||
		!isCheckoutSessionClientSecret(result.client_secret)
	) {
		return null;
	}
	return result.client_secret;
}

export function walletTopupPaymentIntentClientSecret(
	result: WalletTopupResult,
): PaymentIntentClientSecret | null {
	if (result.flow_type !== "payment_intent" || !isPaymentIntentClientSecret(result.client_secret)) {
		return null;
	}
	return result.client_secret;
}

export function walletAutoReloadPaymentIntentClientSecret(
	action: WalletAutoReloadAction | null | undefined,
): PaymentIntentClientSecret | null {
	if (!action || !isPaymentIntentClientSecret(action.client_secret)) return null;
	return action.client_secret;
}

export function stripeReturnPaymentIntentClientSecret(
	value: unknown,
): PaymentIntentClientSecret | null {
	return isPaymentIntentClientSecret(value) ? value : null;
}
