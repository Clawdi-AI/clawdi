import { globalWalletBalanceClasses as styles } from "@clawdi/shared/ui";
import {
	billingCopy,
	headerWalletBalanceControlPresentation,
	headerWalletBalancePresentation,
} from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { WalletCards } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WebIcon, WebText, webView } from "@/components/ui/web-layout";
import { formatCredits } from "@/hosted/billing/store/store-presentation";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useStoreSurfaces } from "@/platform/store/store-provider";

function useWalletPresentation() {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const t = useI18n();
	const { creditUnits } = useStoreSurfaces();
	const wallet = useQuery({
		queryKey: accountQueryKey(scope, "billing-wallet"),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
		queryFn: ({ signal }) =>
			read((lease) => {
				if (!compute) throw new Error("Compute unavailable");
				return compute.getWallet(lease);
			}, signal),
	});
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
export function GlobalWalletBalance() {
	const { compute, scope, state, displayedBalance, label } = useWalletPresentation();
	if (!compute) return null;
	return (
		<Button
			variant="ghost"
			size="sm"
			className={webView(styles.control).replace(/\bw-full\b/g, "")}
			accessibilityLabel={label}
			onPress={() => {
				if (scope.isCurrent() && !scope.signal.aborted) router.push("/settings/wallet");
			}}
		>
			<WebIcon as={WalletCards} recipe={styles.icon} />
			{state === "loading" ? (
				<Skeleton className={webView(styles.skeleton)} />
			) : displayedBalance ? (
				<WebText recipe={styles.balance.replace(/\bflex-1\b/g, "")}>{displayedBalance}</WebText>
			) : null}
		</Button>
	);
}
