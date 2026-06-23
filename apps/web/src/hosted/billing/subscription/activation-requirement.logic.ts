import type { ActivationFeeStatus, Subscription } from "@/hosted/billing/contracts";

export interface ActivationRequirement {
	/** Whether the activation gate should render at all. */
	required: boolean;
	/** A one-time activation fee is owed. */
	feeDue: boolean;
	/** A card / payment method must be set up to activate. */
	cardSetup: boolean;
	feeAmountCents: number;
}

/**
 * Pure decision for the activation gate. Prefers the focused activation-fee
 * status, falling back to the snapshot the subscription carries so a fee still
 * surfaces if that query hasn't landed. The fee defaults to satisfied (no gate)
 * when nothing is known, so the card never shows speculatively.
 */
export function activationRequirement(
	sub: Pick<
		Subscription,
		"card_setup_required" | "activation_fee_amount_cents" | "activation_fee_satisfied"
	> | null,
	fee: ActivationFeeStatus | null,
): ActivationRequirement {
	const feeAmountCents = fee?.amount_cents ?? sub?.activation_fee_amount_cents ?? 0;
	const feeSatisfied = fee ? fee.satisfied : (sub?.activation_fee_satisfied ?? true);
	const feeDue = feeAmountCents > 0 && !feeSatisfied;
	const cardSetup = !!sub?.card_setup_required;
	return { required: feeDue || cardSetup, feeDue, cardSetup, feeAmountCents };
}
