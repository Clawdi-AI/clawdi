import { welcomeWalletCardClasses as styles } from "@clawdi/shared/ui";
import {
	welcomeWalletCopy as copy,
	formatUsdExact,
	WELCOME_GRANT_RECHECK_INTERVAL_MS,
	WELCOME_GRANT_TIMEOUT_MS,
	welcomeWalletDescription,
	welcomeWalletTitle,
} from "@clawdi/shared/view";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Gift, PartyPopper, RefreshCw } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webBoth, webView } from "@/components/ui/web-layout";
import { nextBillingCursor } from "@/hosted/billing/format";
import { formatCredits } from "@/hosted/billing/store/store-presentation";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useStoreSurfaces } from "@/platform/store/store-provider";

/**
 * Web's welcome + signup-grant feedback under the first-agent onboarding card. It reads
 * the Wallet and its `grant_signup` transaction, and re-checks a pending grant for a
 * minute while the app is in the foreground before offering a manual refresh.
 */
export function WelcomeWalletCard() {
	const t = useI18n();
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const surfaces = useStoreSurfaces();
	const [checkStartedAt, setCheckStartedAt] = useState(() => Date.now());
	const [timedOut, setTimedOut] = useState(false);
	// Same keys as the Wallet page, so both screens share one cache entry.
	const wallet = useQuery({
		queryKey: accountQueryKey(scope, "billing-wallet"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getWallet(s);
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const transactions = useInfiniteQuery({
		queryKey: accountQueryKey(scope, "billing-transactions"),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ signal, pageParam }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getWalletTransactions({ limit: 25, cursor: pageParam }, s);
			}, signal),
		getNextPageParam: nextBillingCursor,
		enabled: scope.isReady && Boolean(compute),
		retry: false,
		refetchInterval: (query) => {
			const pending = query.state.data?.pages
				.flatMap((page) => page.items)
				.some((entry) => entry.kind === "grant_signup" && entry.status === "pending");
			return pending && !timedOut ? WELCOME_GRANT_RECHECK_INTERVAL_MS : false;
		},
		refetchIntervalInBackground: false,
	});
	const grant = transactions.data?.pages
		.flatMap((page) => page.items)
		.find((entry) => entry.kind === "grant_signup");
	const grantApplied = grant?.status === "applied";
	const grantPending = grant?.status === "pending";
	useEffect(() => {
		if (!grantPending || timedOut) return;
		const remaining = Math.max(0, checkStartedAt + WELCOME_GRANT_TIMEOUT_MS - Date.now());
		const timer = setTimeout(() => setTimedOut(true), remaining);
		return () => clearTimeout(timer);
	}, [checkStartedAt, grantPending, timedOut]);

	if (!compute) return null;
	if (wallet.isPending || transactions.isPending)
		return (
			<Card accessibilityLabel={copy.loading}>
				<CardContent>
					<WebView recipe={styles.skeletonBody}>
						<Skeleton className={webView(styles.skeletonTitle)} />
						<Skeleton className={webView(styles.skeletonLine)} />
					</WebView>
				</CardContent>
			</Card>
		);
	const walletError = wallet.data ? null : wallet.error;
	const transactionsError = transactions.data ? null : transactions.error;
	if (walletError || transactionsError)
		return (
			<Card>
				<CardContent>
					<ApiErrorPanel
						error={walletError ?? transactionsError}
						title={copy.loadError}
						onRetry={() => {
							if (walletError) void wallet.refetch();
							if (transactionsError) void transactions.refetch();
						}}
					/>
				</CardContent>
			</Card>
		);
	if (!wallet.data) return null;
	const grantAmount = grant
		? surfaces.creditUnits
			? formatCredits(grant.amount, t("store.credits"))
			: formatUsdExact(grant.amount)
		: null;
	const state = { grantApplied, grantPending, grantCheckTimedOut: timedOut, grantAmount };
	return (
		<Card className={webView(styles.card)}>
			<CardContent className={webView(styles.content)}>
				<WebView recipe={styles.summary} className="flex-row">
					{/* RN has no `[&>svg]` child selector; the icon takes Web's size-6 directly. */}
					<Icon
						as={grantApplied ? PartyPopper : Gift}
						className={`${webBoth(styles.icon)} size-6`}
					/>
					<WebView recipe={styles.body} className="flex-1">
						<WebText recipe={styles.title}>{welcomeWalletTitle(state)}</WebText>
						<WebText recipe={styles.description}>{welcomeWalletDescription(state)}</WebText>
					</WebView>
				</WebView>
				{grantPending ? (
					<WebView recipe={styles.actions} className="flex-row">
						{timedOut ? (
							<Button
								variant="outline"
								disabled={transactions.isFetching}
								onPress={() => {
									setTimedOut(false);
									setCheckStartedAt(Date.now());
									void transactions.refetch();
								}}
							>
								{transactions.isFetching ? <Spinner /> : <Icon as={RefreshCw} />}
								<Text>{copy.refresh}</Text>
							</Button>
						) : (
							<Spinner />
						)}
					</WebView>
				) : null}
			</CardContent>
		</Card>
	);
}
