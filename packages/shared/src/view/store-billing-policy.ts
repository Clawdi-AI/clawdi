import type { ComputeSubscriptionAction } from "./compute-subscription-actions";

/** Card/Wallet subscription actions the Clawdi app renders; recovery keeps its own paths. */
export type AppComputeActionKind =
	| "manage"
	| "upgrade"
	| "start_new"
	| "check_change"
	| "cancel"
	| "end_trial"
	| "resume"
	| "cancel_scheduled_change";

export type AppComputeAction = ComputeSubscriptionAction & { kind: AppComputeActionKind };

/**
 * Web's subscription actions for the Clawdi app. Other builds keep Web's set. Store
 * builds hide card-only surfaces (D-1, card half): a card row offers only actions that
 * never charge it (cancel, end trial, cancel a scheduled change). Wallet-funded rows,
 * Included Basic upgrades and new subscriptions for a stopped Agent spend Wallet balance
 * or assign an existing subscription, so they keep Web's actions in every build.
 */
export function appComputeActions(
	storeBuild: boolean,
	row: { fundingSource: string | null | undefined },
	actions: readonly ComputeSubscriptionAction[],
): AppComputeAction[] {
	const cardRow = storeBuild && row.fundingSource === "stripe";
	return actions.filter((action): action is AppComputeAction => {
		switch (action.kind) {
			case "cancel":
			case "end_trial":
			case "cancel_scheduled_change":
			case "start_new":
				return true;
			case "manage":
			case "upgrade":
			case "resume":
			case "check_change":
				return !cardRow;
			default:
				return false;
		}
	});
}

/**
 * Funding the app offers. A new subscription is Wallet-funded in every build: the app
 * has no card checkout. Other builds keep Web's card or Wallet choice for plan changes,
 * which charge the saved card through hosted; store builds never charge a card.
 */
export function fundingSourcesFor(
	storeBuild: boolean,
	context: "new_subscription" | "plan_change",
): readonly ("stripe" | "wallet")[] {
	return !storeBuild && context === "plan_change" ? ["stripe", "wallet"] : ["wallet"];
}
