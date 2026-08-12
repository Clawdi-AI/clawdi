import { bootstrapWalletTopupReturn } from "@/hosted/billing/wallet/top-up-return.logic";

if (typeof window !== "undefined") {
	bootstrapWalletTopupReturn(
		window.location.href,
		window.history.state,
		window.history.replaceState.bind(window.history),
	);
}
