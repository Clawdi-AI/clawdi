import { globalWalletBalanceClasses as styles } from "@clawdi/shared/ui";
import { headerWalletBalancePresentation } from "@clawdi/shared/view";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { WalletCards } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WebIcon, WebText, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";

export function GlobalWalletBalance() {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
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
	const { displayedBalance, label } = headerWalletBalancePresentation(
		state,
		wallet.data?.balance_usd,
		true,
	);
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
