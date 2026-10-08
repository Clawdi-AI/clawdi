import type { onlineManager } from "@tanstack/react-query";
import type { AppState } from "react-native";
import type { PurchaseFlow, PurchaseOutcome } from "./purchase-flow";

export type StoreRefreshOptions = Readonly<{ recover: boolean }>;

/** Lifecycle recovery publishes outcomes only while its foreground lease is current. */
export async function recoverStoreRefresh(
	{ recover }: StoreRefreshOptions,
	flow: Pick<PurchaseFlow, "recover">,
	signal: AbortSignal,
	publish: (recovery: readonly PurchaseOutcome[]) => void,
): Promise<void> {
	if (!recover) return;
	const recovery = await flow.recover(signal).catch(() => []);
	if (!signal.aborted) publish(recovery);
}

/** Lifecycle refreshes reconcile pending purchases; action refreshes choose their own mode. */
export function subscribeStoreRefresh({
	refresh,
	appState,
	online,
	abort,
}: {
	refresh: (options: StoreRefreshOptions) => Promise<void>;
	appState: Pick<typeof AppState, "addEventListener">;
	online: Pick<typeof onlineManager, "subscribe">;
	abort: () => void;
}): () => void {
	void refresh({ recover: true });
	const subscription = appState.addEventListener("change", (value) => {
		if (value === "active") void refresh({ recover: true });
		else abort();
	});
	const unsubscribeOnline = online.subscribe((connected) => {
		if (connected) void refresh({ recover: true });
	});
	return () => {
		unsubscribeOnline();
		subscription.remove();
	};
}

/** Only hosted funding/submission outcomes can change the Wallet reads. */
export async function refreshRecoveredWallet(
	recovery: readonly PurchaseOutcome[],
	refresh: () => Promise<unknown>,
): Promise<void> {
	if (
		recovery.some(
			(outcome) => outcome.status === "funding_applied" || outcome.status === "submitted",
		)
	)
		await refresh();
}
