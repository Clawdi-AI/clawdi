import type { ComputeSubscriptionAction } from "./compute-subscription-actions";
import type { ComputeFundingSource } from "./compute-subscriptions";

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
 * builds hide card-only surfaces (D-1, card half): only Wallet-funded rows and Included
 * Basic keep the actions that can charge (plan changes, resume); any other row, such as
 * card or legacy null funding with a price, offers only actions that never charge it
 * (cancel, end trial, cancel a scheduled change). New subscriptions for a stopped Agent
 * spend Wallet balance or assign an existing subscription, so every build offers them.
 *
 * `fundingSource` is the normalized `computeFundingSource`, never the raw wire field.
 */
export function appComputeActions(
	storeBuild: boolean,
	row: { fundingSource: ComputeFundingSource },
	actions: readonly ComputeSubscriptionAction[],
): AppComputeAction[] {
	const charges =
		!storeBuild || row.fundingSource === "wallet" || row.fundingSource === "included_basic";
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
				return charges;
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
