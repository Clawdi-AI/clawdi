import type { ComputeRecoveryTarget, StoreBootstrap, StorePlatform } from "@clawdi/shared/api";
import { Platform } from "react-native";
import type { MobileRuntimeConfig } from "@/lib/config/runtime-config";

/** The store that bills purchases made on this device. */
export function currentStorePlatform(): StorePlatform | null {
	return Platform.OS === "ios" ? "app_store" : Platform.OS === "android" ? "play_store" : null;
}

/** M2 uses this policy for card-only surfaces, independently of IAP availability. */
export function isStoreBuild(config: Pick<MobileRuntimeConfig, "environment">): boolean {
	return config.environment === "production";
}

export type StoreSurfaces = Readonly<{
	/** Auto-reload, saved cards, card setup, USDC funding, Stripe receipts, card recovery and portal. */
	cardBilling: boolean;
	/** The official RevenueCat Paywall entry for the `credits` offering. */
	addCredits: boolean;
	/** Wallet amounts and compute prices are shown as credits, never as dollars. */
	creditUnits: boolean;
}>;

/**
 * Store builds hide card-only surfaces (owner-approved, 2026-10-06) and always show
 * the credits entry, disabled while purchases are unavailable. Other builds keep Web
 * parity; they show the entry only when a debug build has a usable store flow.
 */
export function storeSurfaces(storeBuild: boolean, purchasesAvailable: boolean): StoreSurfaces {
	return {
		cardBilling: !storeBuild,
		addCredits: storeBuild || purchasesAvailable,
		creditUnits: storeBuild,
	};
}

/** Compute subscriptions require every independent release and server gate. */
export function computePurchaseAvailable(
	config: Pick<MobileRuntimeConfig, "environment">,
	bootstrap: Pick<StoreBootstrap, "compute_subscriptions_enabled" | "compute_slot"> | null,
	target: Readonly<{
		pending_deploy_request_id?: string | null;
		target_contract_id?: string | null;
		target_deployment_id?: string | null;
	}> = {},
): boolean {
	const isPlanChange = target.target_contract_id != null;
	return Boolean(
		isStoreBuild(config) &&
			bootstrap?.compute_subscriptions_enabled &&
			(isPlanChange || bootstrap.compute_slot?.available),
	);
}

/** Wallet-rail `top_up` recovery opens the Paywall; card recovery becomes a neutral status. */
export function storeRecoveryAction(
	surfaces: StoreSurfaces,
	target: ComputeRecoveryTarget | null,
): "add_credits" | "card_status" | "default" {
	if (target?.kind === "top_up" && surfaces.addCredits) return "add_credits";
	if ((target?.kind === "invoice" || target?.kind === "fix_payment") && !surfaces.cardBilling)
		return "card_status";
	return "default";
}
