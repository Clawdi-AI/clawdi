import { useQueryClient } from "@tanstack/react-query";
import { Coins } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import {
	purchaseErrorNotice,
	purchaseOutcomeNotice,
	type StoreNotice,
} from "@/hosted/billing/store/store-presentation";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { usePaywall } from "@/platform/store/paywall-host";
import { loadCreditsOffering } from "@/platform/store/revenuecat";
import { type PurchaseErrorCode, storePurchaseError } from "@/platform/store/store-error";
import { useMobileStore } from "@/platform/store/store-provider";

/** Wallet reads that a store top-up can change. */
function useRefreshWallet() {
	const cache = useQueryClient();
	const scope = useAccountScope();
	return () =>
		Promise.all(
			(["billing-wallet", "billing-transactions"] as const).map((key) =>
				cache.invalidateQueries({ queryKey: accountQueryKey(scope, key) }),
			),
		);
}

/** Start/foreground recovery can settle an earlier purchase; show its Wallet effect. */
export function useStoreRecoveryRefresh() {
	const { recovery } = useMobileStore();
	const refresh = useRefreshWallet();
	const funded = recovery.some(
		(outcome) => outcome.status === "funding_applied" || outcome.status === "submitted",
	);
	useEffect(() => {
		if (funded) void refresh();
	}, [recovery, funded]);
}

/**
 * Explicit "Add credits" intent: opens the official RevenueCat Paywall for the
 * `credits` offering through the M1 purchase flow. Only hosted settlement adds credits.
 */
export function AddCreditsAction({
	onFunded,
	size,
}: {
	onFunded?: () => void;
	size?: "default" | "sm";
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const store = useMobileStore();
	const present = usePaywall();
	const refresh = useRefreshWallet();
	const action = useAuthAction(scope);
	const [notice, setNotice] = useState<StoreNotice | null>(null);
	const flow = store.flow;
	const available = flow !== null && present !== null;
	const buy = () =>
		action.run(async (owns) => {
			if (!flow || !present) return;
			setNotice(null);
			let next: StoreNotice | null;
			try {
				const offering = await loadCreditsOffering();
				let failure: PurchaseErrorCode | null = null;
				const outcome = await flow.purchase({ purpose: "standalone_topup" }, (signal) => {
					const session = present(offering, signal);
					return session.result.finally(() => {
						failure = session.failure();
					});
				});
				next = purchaseOutcomeNotice(outcome, failure);
			} catch (error) {
				next = purchaseErrorNotice(storePurchaseError(error).code);
			}
			if (!owns()) return;
			setNotice(next);
			if (next?.refresh) {
				await refresh();
				if (owns()) onFunded?.();
			}
		});
	return (
		<AppView className="gap-2">
			<Button size={size} disabled={!available || action.busy} onPress={() => void buy()}>
				<Icon as={Coins} />
				<Text>{t(action.busy ? "store.purchasing" : "store.addCredits")}</Text>
			</Button>
			{!available ? (
				<Text className="text-muted-foreground">{t("store.unavailable")}</Text>
			) : notice ? (
				<Text
					accessibilityRole={notice.tone === "warning" ? "alert" : undefined}
					className={
						notice.tone === "success" ? "text-success-muted-foreground" : "text-muted-foreground"
					}
				>
					{t(notice.key)}
				</Text>
			) : action.error ? (
				<Text accessibilityRole="alert" className="text-muted-foreground">
					{t("store.failed")}
				</Text>
			) : null}
		</AppView>
	);
}
