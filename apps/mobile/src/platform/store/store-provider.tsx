import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AppState, Platform } from "react-native";
import { useMobileApi } from "@/lib/api-provider";
import type { MobileRuntimeConfig } from "@/lib/config/runtime-config";
import { useAccountScope } from "@/platform/account-lifecycle";
import type { AccountScope } from "@/platform/auth/account-scope";
import { createPurchaseAttemptStore } from "./purchase-attempt-storage";
import { createPurchaseFlow, type PurchaseFlow, type PurchaseOutcome } from "./purchase-flow";
import { revenueCat } from "./revenuecat";
import { type StorePurchaseError, storePurchaseError } from "./store-error";
import { createStoreIdentity, type StoreAvailability } from "./store-identity";
import { isStoreBuild, type StoreSurfaces, storeSurfaces } from "./store-policy";
import { recoverStoreFlow } from "./store-recovery";

const journal = createPurchaseAttemptStore(SecureStore);
type MobileStore = Readonly<{
	availability: StoreAvailability;
	flow: PurchaseFlow | null;
	recovery: readonly PurchaseOutcome[];
	error: StorePurchaseError | null;
}>;
type MobileStoreContext = MobileStore & Readonly<{ storeBuild: boolean }>;
const unavailable: MobileStore = {
	availability: { available: false, reason: "store_purchases_disabled" },
	flow: null,
	recovery: [],
	error: null,
};
const StoreContext = createContext<MobileStoreContext>({ ...unavailable, storeBuild: false });

/** Mounts no UI. Account scope and foreground leases fence every async result. */
export function StoreProvider({
	config,
	children,
}: {
	config: MobileRuntimeConfig;
	children: ReactNode;
}) {
	const scope = useAccountScope();
	const { store: client } = useMobileApi();
	const [state, setState] = useState<{ scope: AccountScope; value: MobileStore } | null>(null);
	useEffect(() => {
		let mounted = true;
		let recovering = false;
		let lease: AbortController | null = null;
		const current = () => mounted && scope.isCurrent() && !scope.signal.aborted;
		const update = (value: MobileStore) => {
			if (current()) setState({ scope, value });
		};
		if (!scope.isReady) {
			// Keep the SDK identity: RevenueCat logout would create an anonymous customer.
			return () => {
				mounted = false;
			};
		}
		const platform =
			Platform.OS === "ios" ? "app_store" : Platform.OS === "android" ? "play_store" : null;
		if (!platform || !client)
			return () => {
				mounted = false;
			};
		const identity = createStoreIdentity({ scope, client, sdk: revenueCat, config, platform });
		let flow: PurchaseFlow | null = null;
		const refresh = async () => {
			if (!current() || recovering || flow?.isBusy()) return;
			recovering = true;
			const controller = new AbortController();
			lease = controller;
			const abort = () => controller.abort();
			scope.signal.addEventListener("abort", abort, { once: true });
			try {
				const availability = await identity.initialize(controller.signal);
				if (!current() || controller.signal.aborted) return;
				if (!availability.available) {
					update({ ...unavailable, availability });
					return;
				}
				if (!flow) {
					const digest = await Crypto.digestStringAsync(
						Crypto.CryptoDigestAlgorithm.SHA256,
						JSON.stringify([config.computeApiUrl, scope.accountKey, platform]),
					);
					if (!current() || controller.signal.aborted) return;
					flow = createPurchaseFlow({
						scope,
						client,
						identity,
						sdk: revenueCat,
						platform,
						journal,
						storageKey: `clawdi.store.v1.${digest}`,
						newKey: Crypto.randomUUID,
					});
				}
				update({ availability, flow, recovery: [], error: null });
				const recovered = await recoverStoreFlow(flow, controller.signal);
				if (!controller.signal.aborted) update({ availability, ...recovered });
			} catch (error) {
				if (!controller.signal.aborted)
					update({ ...unavailable, error: storePurchaseError(error) });
			} finally {
				scope.signal.removeEventListener("abort", abort);
				recovering = false;
				if (controller.signal.aborted && AppState.currentState === "active" && current())
					void refresh();
			}
		};
		void refresh();
		const subscription = AppState.addEventListener("change", (value) => {
			if (value === "active") void refresh();
			else lease?.abort();
		});
		return () => {
			mounted = false;
			lease?.abort();
			subscription.remove();
		};
	}, [scope, client, config]);
	const active = state?.scope === scope ? state.value : unavailable;
	const storeBuild = isStoreBuild(config);
	const value = useMemo(() => ({ ...active, storeBuild }), [active, storeBuild]);
	return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useMobileStore(): MobileStoreContext {
	return useContext(StoreContext);
}

export function useStoreSurfaces(): StoreSurfaces {
	const store = useMobileStore();
	return storeSurfaces(store.storeBuild, store.flow !== null);
}
