import type { ComponentProps } from "react";
import type { StripeCheckoutDialog } from "@/hosted/billing/components/stripe-checkout-dialog";
import type {
	CheckoutSessionClientSecret,
	PaymentIntentClientSecret,
} from "@/hosted/billing/stripe-client-secret";
import type { StripePaymentForm } from "@/hosted/billing/wallet/stripe-payment-form";

declare const checkoutSecret: CheckoutSessionClientSecret;
declare const paymentIntentSecret: PaymentIntentClientSecret;

declare function acceptCheckoutSecret(
	value: ComponentProps<typeof StripeCheckoutDialog>["clientSecret"],
): void;
declare function acceptPaymentIntentSecret(
	value: ComponentProps<typeof StripePaymentForm>["clientSecret"],
): void;

acceptCheckoutSecret(checkoutSecret);
acceptPaymentIntentSecret(paymentIntentSecret);

// @ts-expect-error PaymentIntent secrets cannot initialize CheckoutElementsProvider.
acceptCheckoutSecret(paymentIntentSecret);
// @ts-expect-error Checkout Session secrets cannot initialize Elements.
acceptPaymentIntentSecret(checkoutSecret);

const stripeAcceptsCheckoutAsString: string = checkoutSecret;
const stripeAcceptsPaymentIntentAsString: string = paymentIntentSecret;
void stripeAcceptsCheckoutAsString;
void stripeAcceptsPaymentIntentAsString;
