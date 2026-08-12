import { bootstrapWalletTopupReturn } from "@/lib/wallet-topup-return";

if (typeof window !== "undefined") {
	bootstrapWalletTopupReturn(
		window.location.href,
		window.history.state,
		window.history.replaceState.bind(window.history),
	);
}
