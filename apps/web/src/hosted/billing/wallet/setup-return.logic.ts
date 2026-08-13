import { SETTINGS_QUERY_KEY } from "@/lib/settings-routes";
import {
	buildWalletStripeReturnUrl,
	WALLET_SETUP_IDENTITY_PARAM,
	WALLET_SETUP_RETURN_PARAM,
} from "@/lib/wallet-stripe-return";

export function buildWalletSetupReturnUrl(currentHref: string, setupIdentity: string): string {
	return buildWalletStripeReturnUrl(currentHref, [
		[SETTINGS_QUERY_KEY, "billing-wallet"],
		[WALLET_SETUP_RETURN_PARAM, "1"],
		[WALLET_SETUP_IDENTITY_PARAM, setupIdentity],
	]);
}
