import type {
	StoreBootstrap,
	StoreComputeReconcileResponse,
	StoreComputeSlot,
} from "@clawdi/shared/api";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { AppState, Platform } from "react-native";
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
import { StorePurchaseError, storePurchaseError } from "./store-error";
import { createStoreIdentity, type StoreAvailability } from "./store-identity";
import { createStoreManagement, type StoreManagementController } from "./store-management";
import {
	computePurchaseAvailable,
	isStoreBuild,
	type StoreSurfaces,
	storeSurfaces,
} from "./store-policy";
import { recoverStoreFlow } from "./store-recovery";
import { preserveRestoreState, restoreStorePurchases } from "./store-restore";

const journal = createPurchaseAttemptStore(SecureStore);
type MobileStore = Readonly<{
	availability: StoreAvailability;
	flow: PurchaseFlow | null;
	recovery: readonly PurchaseOutcome[];
	error: StorePurchaseError | null;
	bootstrap: StoreBootstrap | null;
	computeSubscriptionsEnabled: boolean;
	computeSlot: StoreComputeSlot | null;
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
	Readonly<{ storeBuild: boolean; customerCenterEnabled: boolean }>;

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
	availability: { available: false, reason: "store_purchases_disabled" },
	flow: null,
	recovery: [],
	error: null,
	bootstrap: null,
	computeSubscriptionsEnabled: false,
	computeSlot: null,
	computeProducts: [],
	computeOffering: null,
	purchaseComputeSubscription: unavailablePurchase,
	restorePurchases: unavailableRestore,
	management: null,
};
const StoreContext = createContext<MobileStoreContext>({
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
		let recovering = false;
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
		const platform =
			Platform.OS === "ios" ? "app_store" : Platform.OS === "android" ? "play_store" : null;
		if (!platform || !client)
			return () => {
				mounted = false;
			};
		const identity = createStoreIdentity({ scope, client, sdk: revenueCat, config, platform });
		const management = createStoreManagement({ scope, identity, sdk: revenueCat, platform });
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
				const bootstrap = availability.bootstrap;
				let latestBootstrap = bootstrap;
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
					if (!computePurchaseAvailable(config, latestBootstrap, request))
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
					const restoredState = preserveRestoreState(
						{
							computeSlot: latestValue?.computeSlot ?? latestBootstrap.compute_slot ?? null,
							recovery: latestValue?.recovery ?? [],
							error: latestValue?.error ?? null,
						},
						result,
					);
					const computeSlot = restoredState.computeSlot;
					latestBootstrap = { ...latestBootstrap, compute_slot: computeSlot };
					if (current())
						update({
							availability: {
								available: true,
								bootstrap: latestBootstrap,
							},
							flow,
							recovery: restoredState.recovery,
							error: restoredState.error,
							bootstrap: latestBootstrap,
							computeSubscriptionsEnabled: latestBootstrap.compute_subscriptions_enabled,
							computeSlot,
							computeProducts,
							computeOffering,
							purchaseComputeSubscription,
							restorePurchases,
							management,
						});
					return result;
				};
				update({
					availability,
					flow,
					recovery: [],
					error: null,
					bootstrap,
					computeSubscriptionsEnabled: bootstrap.compute_subscriptions_enabled,
					computeSlot: bootstrap.compute_slot ?? null,
					computeProducts,
					computeOffering,
					purchaseComputeSubscription,
					restorePurchases,
					management,
				});
				const recovered = await recoverStoreFlow(flow, controller.signal);
				if (!controller.signal.aborted)
					update({
						availability,
						...recovered,
						bootstrap,
						computeSubscriptionsEnabled: bootstrap.compute_subscriptions_enabled,
						computeSlot: bootstrap.compute_slot ?? null,
						computeProducts,
						computeOffering,
						purchaseComputeSubscription,
						restorePurchases,
						management,
					});
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
	const customerCenterEnabled = config.revenueCatCustomerCenterEnabled === true;
	const value = useMemo(
		() => ({ ...active, storeBuild, customerCenterEnabled }),
		[active, storeBuild, customerCenterEnabled],
	);
	return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useMobileStore(): MobileStoreContext {
	return useContext(StoreContext);
}

export function useStoreSurfaces(): StoreSurfaces {
	const store = useMobileStore();
	return storeSurfaces(store.storeBuild, store.flow !== null);
}
