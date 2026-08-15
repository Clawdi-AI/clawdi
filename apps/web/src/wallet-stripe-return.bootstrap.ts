import {
	hasWalletStripeReturnUrl,
	scrubWalletStripeReturnLocation,
} from "@/lib/wallet-stripe-return-security";

const IS_HOSTED_BUILD = import.meta.env.VITE_CLAWDI_HOSTED === "true";
const loadHostedWalletStripeReturn = IS_HOSTED_BUILD
	? () => import("@/hosted/billing/wallet/stripe-return")
	: null;

export async function bootstrapWalletStripeReturnBeforeTelemetry(): Promise<void> {
	if (typeof window === "undefined") return;
	const currentHref = window.location.href;
	if (!hasWalletStripeReturnUrl(currentHref)) return;
	const historyState = window.history.state;
	scrubWalletStripeReturnLocation(
		currentHref,
		historyState,
		window.history.replaceState.bind(window.history),
	);

	if (loadHostedWalletStripeReturn) {
		try {
			const { bootstrapWalletStripeReturn } = await loadHostedWalletStripeReturn();
			bootstrapWalletStripeReturn(currentHref, historyState, () => {});
			return;
		} catch {
			// The address bar is already scrubbed; lifecycle recovery is best-effort.
		}
	}
}
