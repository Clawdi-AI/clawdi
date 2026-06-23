"use client";

import { CreditCard, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { formatCentsCompact } from "@/hosted/billing/format";
import { useActivationFee, usePortal, useSubscription } from "@/hosted/billing/hooks";
import { activationRequirement } from "@/hosted/billing/subscription/activation-requirement.logic";
import { useActionLock } from "@/hosted/billing/use-action-lock";

/**
 * Activation gate: an unmet activation fee or a required card setup
 * for hosted billing. Driven by `useActivationFee()` and `subscription.card_setup_required`,
 * it surfaces ONLY when the backend actually requires action — otherwise it
 * returns null so it can sit unconditionally on the subscription surface.
 *
 * The CTA opens the billing portal, where the user adds a card / pays the fee;
 * a successful return refetches the subscription and this card clears itself.
 */
export function ActivationRequirementCard() {
	const subscription = useSubscription();
	const activationFee = useActivationFee();
	const portal = usePortal();
	const runAction = useActionLock();

	const sub = subscription.data ?? null;
	const fee = activationFee.data ?? null;
	const { required, feeDue, feeAmountCents } = activationRequirement(sub, fee);

	if (!required) return null;

	async function openPortal() {
		try {
			const res = await portal.mutateAsync({ confirm_upgrade: false });
			if (res.url || res.portal_url) {
				window.location.href = res.url || res.portal_url;
				return;
			}
			toast.message("Billing portal unavailable", {
				description: res.message ?? "Please try again in a moment.",
			});
		} catch (e) {
			toast.error("Couldn’t open billing", { description: normalizeBillingError(e) });
		}
	}

	const title = feeDue ? "Activate your plan" : "Add a payment method to activate";
	const body = feeDue
		? `A one-time activation fee of ${formatCentsCompact(feeAmountCents)} is due to start your plan. Add a card to pay it — your agent keeps running on Free until then.`
		: "Your plan needs a payment method on file to activate. Add a card to finish setup — your agent keeps running on Free until then.";

	return (
		<Card data-hosted="true" className="border-warning/40 bg-warning-muted/30">
			<CardContent className="flex flex-col gap-3 sm:flex-row sm:items-start">
				<ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
				<div className="flex-1 space-y-3">
					<div className="space-y-1">
						<p className="font-medium">{title}</p>
						<p className="text-sm text-muted-foreground">{body}</p>
					</div>
					<Button size="sm" onClick={() => runAction(openPortal)} disabled={portal.isPending}>
						{portal.isPending ? <Spinner /> : <CreditCard />}
						{feeDue ? "Pay activation fee" : "Add payment method"}
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}
