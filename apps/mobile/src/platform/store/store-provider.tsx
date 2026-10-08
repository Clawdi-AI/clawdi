import type {
	StoreBootstrap,
	StoreComputeReconcileResponse,
	StoreComputeSlot,
} from "@clawdi/shared/api";
import { onlineManager } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import type { PurchasesOffering } from "react-native-purchases";
import { useMobileApi } from "@/lib/api-provider";
import type { MobileRuntimeConfig } from "@/lib/config/runtime-config";
import { useAccountScope } from "@/platform/account-lifecycle";
import type { AccountScope } from "@/platform/auth/account-scope";
import {
	type ComputeProduct,
	type ComputeProductSelection,
	createComputeSubscriptionPurchase,
	loadComputeOfferingForIdentity,
	loadComputeProductsForIdentity,
} from "./compute-subscription";
import { createPurchaseAttemptStore } from "./purchase-attempt-storage";
import { createPurchaseFlow, type PurchaseFlow, type PurchaseOutcome } from "./purchase-flow";
import { revenueCat } from "./revenuecat";
import { StorePurchaseError } from "./store-error";
import { createStoreIdentity } from "./store-identity";
import { createStoreManagement, type StoreManagementController } from "./store-management";
import { currentStorePlatform } from "./store-platform";
import {
	computePurchaseAvailable,
	isStoreBuild,
	type StoreSurfaces,
	storeSurfaces,
} from "./store-policy";
import {
	recoverStoreRefresh,
	type StoreRefreshOptions,
	subscribeStoreRefresh,
} from "./store-refresh";
import { restoreStorePurchases } from "./store-restore";

const journal = createPurchaseAttemptStore(SecureStore);
type MobileStore = Readonly<{
	flow: PurchaseFlow | null;
	recovery: readonly PurchaseOutcome[];
	bootstrap: StoreBootstrap | null;
	refresh: (options: StoreRefreshOptions) => Promise<void>;
	computeProducts: readonly ComputeProduct[];
	computeOffering: PurchasesOffering | null;
	purchaseComputeSubscription: (
		request: ComputeSubscriptionPurchaseRequest,
		signal?: AbortSignal,
	) => Promise<PurchaseOutcome>;
	restorePurchases: (signal?: AbortSignal) => Promise<StoreComputeReconcileResponse>;
	management: StoreManagementController | null;
}>;
type MobileStoreContext = MobileStore &
	Readonly<{
		storeBuild: boolean;
		customerCenterEnabled: boolean;
		computeSubscriptionsEnabled: boolean;
		computeSlot: StoreComputeSlot | null;
		/** Credits purchases need the flow and the hosted credits switch. */
		creditsAvailable: boolean;
	}>;

export type ComputeSubscriptionPurchaseRequest = Readonly<{
	store_product_id: string;
	pending_deploy_request_id?: string | null;
	target_contract_id?: string | null;
	target_deployment_id?: string | null;
	selection: ComputeProductSelection;
	oldProductIdentifier?: string | null;
}>;

const unavailablePurchase = async (): Promise<PurchaseOutcome> => {
	throw new StorePurchaseError("store_purchases_disabled");
};
const unavailableRestore = async (): Promise<StoreComputeReconcileResponse> => {
	throw new StorePurchaseError("store_purchases_disabled");
};
const unavailable: MobileStore = {
	flow: null,
	recovery: [],
	bootstrap: null,
	refresh: async () => {},
	computeProducts: [],
	computeOffering: null,
	purchaseComputeSubscription: unavailablePurchase,
	restorePurchases: unavailableRestore,
	management: null,
};
function bootstrapState(flow: PurchaseFlow | null, bootstrap: StoreBootstrap | null) {
	return {
		computeSubscriptionsEnabled: bootstrap?.compute_subscriptions_enabled ?? false,
		computeSlot: bootstrap?.compute_slot ?? null,
		creditsAvailable: flow !== null && bootstrap?.purchases_enabled === true,
	};
}
const StoreContext = createContext<MobileStoreContext>({
	...bootstrapState(null, null),
	...unavailable,
	storeBuild: false,
	customerCenterEnabled: false,
});

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
		let refreshing = false;
		let lease: AbortController | null = null;
		let latestValue: MobileStore | null = null;
		const current = () => mounted && scope.isCurrent() && !scope.signal.aborted;
		const update = (value: MobileStore) => {
			latestValue = value;
			if (current()) setState({ scope, value });
		};
		if (!scope.isReady) {
			// Keep the SDK identity: RevenueCat logout would create an anonymous customer.
			return () => {
				mounted = false;
			};
		}
		const platform = currentStorePlatform();
		if (!platform || !client)
			return () => {
				mounted = false;
			};
		const identity = createStoreIdentity({ scope, client, sdk: revenueCat, config, platform });
		const management = createStoreManagement({ scope, identity, sdk: revenueCat });
		let flow: PurchaseFlow | null = null;
		// Lifecycle refreshes recover pending purchases; post-purchase refreshes only observe.
		const refresh = async ({ recover }: StoreRefreshOptions) => {
			if (!current() || refreshing || flow?.isBusy()) return;
			refreshing = true;
			const controller = new AbortController();
			lease = controller;
			const abort = () => controller.abort();
			scope.signal.addEventListener("abort", abort, { once: true });
			try {
				const availability = await identity.initialize(controller.signal);
				if (!current() || controller.signal.aborted) return;
				if (!availability.available) {
					update({ ...unavailable, refresh });
					return;
				}
				const bootstrap = availability.bootstrap;
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
				let computeProducts: readonly ComputeProduct[] = [];
				let computeOffering: PurchasesOffering | null = null;
				if (isStoreBuild(config) && bootstrap.compute_subscriptions_enabled) {
					try {
						computeProducts = await loadComputeProductsForIdentity({
							scope,
							identity,
							sdk: revenueCat,
							platform,
							signal: controller.signal,
						});
					} catch {
						computeProducts = [];
					}
					try {
						computeOffering = await loadComputeOfferingForIdentity({
							scope,
							identity,
							sdk: revenueCat,
							signal: controller.signal,
						});
					} catch {
						computeOffering = null;
					}
				}
				const computePurchase = createComputeSubscriptionPurchase({
					scope,
					identity,
					sdk: revenueCat,
					platform,
				});
				const purchaseComputeSubscription = async (
					request: ComputeSubscriptionPurchaseRequest,
					callerSignal?: AbortSignal,
				): Promise<PurchaseOutcome> => {
					if (!computePurchaseAvailable(config, latestValue?.bootstrap ?? null, request))
						throw new StorePurchaseError("store_purchases_disabled");
					if (!flow) throw new StorePurchaseError("store_purchases_disabled");
					return flow.purchase(
						{
							purpose: "compute_subscription",
							store_product_id: request.store_product_id,
							pending_deploy_request_id: request.pending_deploy_request_id ?? null,
							target_contract_id: request.target_contract_id ?? null,
							target_deployment_id: request.target_deployment_id ?? null,
						},
						(signal, attempt) =>
							computePurchase(
								attempt,
								request.selection,
								request.oldProductIdentifier ?? null,
								signal,
							),
						callerSignal,
						{ nativeOperationManagesIdentity: true },
					);
				};
				const restorePurchases = async (callerSignal?: AbortSignal) => {
					const result = await restoreStorePurchases({
						scope,
						identity,
						sdk: revenueCat,
						client,
						signal: callerSignal,
					});
					if (current() && result.compute_slot && latestValue?.bootstrap) {
						update({
							...latestValue,
							bootstrap: { ...latestValue.bootstrap, compute_slot: result.compute_slot },
						});
					}
					return result;
				};
				update({
					flow,
					recovery: [],
					bootstrap,
					refresh,
					computeProducts,
					computeOffering,
					purchaseComputeSubscription,
					restorePurchases,
					management,
				});
				await recoverStoreRefresh({ recover }, flow, controller.signal, (recovery) => {
					if (latestValue) update({ ...latestValue, recovery });
				});
			} catch {
				if (!controller.signal.aborted) update({ ...unavailable, refresh });
			} finally {
				scope.signal.removeEventListener("abort", abort);
				refreshing = false;
				if (controller.signal.aborted && AppState.currentState === "active" && current())
					void refresh({ recover: true });
			}
		};
		const unsubscribeLifecycle = subscribeStoreRefresh({
			refresh,
			appState: AppState,
			online: onlineManager,
			abort: () => lease?.abort(),
		});
		return () => {
			mounted = false;
			lease?.abort();
			unsubscribeLifecycle();
		};
	}, [scope, client, config]);
	const active = state?.scope === scope ? state.value : unavailable;
	const storeBuild = isStoreBuild(config);
	const customerCenterEnabled = config.revenueCatCustomerCenterEnabled === true;
	const value = useMemo(
		() => ({
			...active,
			...bootstrapState(active.flow, active.bootstrap),
			storeBuild,
			customerCenterEnabled,
		}),
		[active, storeBuild, customerCenterEnabled],
	);
	return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useMobileStore(): MobileStoreContext {
	return useContext(StoreContext);
}

export function useStoreSurfaces(): StoreSurfaces {
	const store = useMobileStore();
	return storeSurfaces(store.storeBuild, store.creditsAvailable);
}
