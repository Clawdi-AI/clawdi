import { bootstrapWalletStripeReturn } from "@/lib/wallet-stripe-return";

if (typeof window !== "undefined") {
	bootstrapWalletStripeReturn(
		window.location.href,
		window.history.state,
		window.history.replaceState.bind(window.history),
	);
}
