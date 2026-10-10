import {
	billingCopy,
	headerWalletBalanceControlPresentation,
	headerWalletBalancePresentation,
} from "@clawdi/shared/view";
import { router } from "expo-router";
import { useWallet } from "@/hosted/billing/hooks";
import { formatCredits } from "@/hosted/billing/store/store-presentation";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountScope } from "@/platform/account-lifecycle";
import { useStoreSurfaces } from "@/platform/store/store-provider";
import { useRefreshOnFocus } from "@/platform/use-refresh-on-focus";

function useWalletPresentation() {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const t = useI18n();
	const { creditUnits } = useStoreSurfaces();
	// The header outlives tab switches; revalidate a stale balance whenever its screen returns.
	useRefreshOnFocus([accountQueryKey(scope, "billing-wallet")]);
	const wallet = useWallet();
	const state = wallet.isPending ? "loading" : wallet.data ? "ready" : "unavailable";
	const balance = wallet.data?.balance_usd;
	const credits = creditUnits && balance ? formatCredits(balance, t("store.credits")) : null;
	const { displayedBalance, label } = creditUnits
		? headerWalletBalanceControlPresentation(state, credits !== "—" ? credits : null, true)
		: headerWalletBalancePresentation(state, balance, true);
	return { compute, scope, state, displayedBalance, label };
}
export function useHeaderWalletBalance() {
	const { compute, scope, displayedBalance, label } = useWalletPresentation();
	return compute
		? {
				id: "wallet",
				label: displayedBalance ?? billingCopy.wallet,
				accessibilityLabel: label,
				onPress: () => {
					if (scope.isCurrent() && !scope.signal.aborted) router.push("/settings/wallet");
				},
			}
		: null;
}
