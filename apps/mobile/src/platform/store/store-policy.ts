import type { ComputeRecoveryTarget, StoreBootstrap } from "@clawdi/shared/api";
import type { ComputeSubscriptionAction } from "@clawdi/shared/view";
import type { MobileRuntimeConfig } from "@/lib/config/runtime-config";

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
 * parity; they show the entry only when a debug build can buy credits.
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

/** Card/Wallet commands the app offers; plan changes and recovery stay on their existing paths. */
export type AppSubscriptionActionKind = Extract<
	ComputeSubscriptionAction["kind"],
	"cancel" | "end_trial" | "resume" | "cancel_scheduled_change"
>;

/**
 * Store builds (owner decision D-1, revised 2026-10-09) may cancel card/Wallet subscriptions,
 * end a trial and drop a scheduled plan change: none of them charges. Resume continues
 * non-IAP billing, so only other builds offer it, like Web. Plan changes keep their own path.
 */
export function appSubscriptionActions(
	surfaces: StoreSurfaces,
	actions: readonly ComputeSubscriptionAction[],
): AppSubscriptionActionKind[] {
	return actions.flatMap((action): AppSubscriptionActionKind[] => {
		if (action.disabledReason !== null) return [];
		switch (action.kind) {
			case "cancel":
			case "end_trial":
			case "cancel_scheduled_change":
				return [action.kind];
			case "resume":
				return surfaces.cardBilling ? [action.kind] : [];
			default:
				return [];
		}
	});
}
