import type { DeployComponents } from "../api";
export const paymentMethodsCopy = {
	empty: "No saved cards yet.",
	more: "Additional saved cards are not shown here.",
	error: "Couldn’t load saved cards",
	billingDefault: "Billing default",
	autoReload: "Auto-reload",
} as const;
export function paymentMethodPresentation(
	method: DeployComponents["schemas"]["V2WalletSavedCardResponse"],
) {
	return {
		title: `${method.card.brand} ending in ${method.card.last4}`,
		expires: `Expires ${String(method.card.exp_month).padStart(2, "0")}/${method.card.exp_year}`,
	};
}
