import { billingCopy, headerWalletBalancePresentation } from "@clawdi/shared/view";
import { router } from "expo-router";
import { useWallet } from "@/hosted/billing/hooks";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountScope } from "@/platform/account-lifecycle";
import { useRefreshOnFocus } from "@/platform/use-refresh-on-focus";

function useWalletPresentation() {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	// The header outlives tab switches; revalidate a stale balance whenever its screen returns.
	useRefreshOnFocus([accountQueryKey(scope, "billing-wallet")]);
	const wallet = useWallet();
	const state = wallet.isPending ? "loading" : wallet.data ? "ready" : "unavailable";
	const { displayedBalance, label } = headerWalletBalancePresentation(
		state,
		wallet.data?.balance_usd,
		true,
	);
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
