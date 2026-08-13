"use client";

import { CreditCard, ExternalLink, Plus, Settings, WalletCards } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { useSensitiveFixPayment } from "@/hosted/billing/sensitive-actions";
import type { ComputeRecoveryTarget } from "@/hosted/billing/subscription/compute-subscription-recovery";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";

export type ComputeSubscriptionStartNewAction =
	| { kind: "link"; href: string; label: string }
	| { kind: "button"; onClick: () => void; label: string };

export function ComputeSubscriptionRecoveryAction({
	target,
	deploymentId,
	startNewAction,
	disabled = false,
	variant = "default",
	startNewIcon = "settings",
}: {
	target: ComputeRecoveryTarget;
	deploymentId: string | null;
	startNewAction: ComputeSubscriptionStartNewAction | null;
	disabled?: boolean;
	variant?: "default" | "destructive";
	startNewIcon?: "plus" | "settings";
}) {
	const fixPayment = useSensitiveFixPayment();
	const runAction = useActionLock();
	const wallet = useWalletSnapshot({ enabled: target.kind === "top_up" });
	const [topUpOpen, setTopUpOpen] = useState(false);

	async function openPaymentRecovery() {
		if (target.kind === "invoice") {
			window.location.href = target.url;
			return;
		}
		if (target.kind !== "fix_payment") return;
		try {
			const result = await fixPayment.execute(deploymentId ? { deployment_id: deploymentId } : {});
			const url = result.url || result.portal_url;
			if (url) {
				window.location.href = url;
				return;
			}
			toast.message("Payment update unavailable", {
				description: "Refresh this page and try again in a moment.",
			});
		} catch (error) {
			toast.error("Couldn't open payment settings", {
				description: normalizeBillingError(error),
			});
		}
	}

	if (target.kind === "top_up") {
		return (
			<>
				<Button
					data-hosted="true"
					type="button"
					size="sm"
					variant={variant}
					onClick={() => setTopUpOpen(true)}
					disabled={disabled || !wallet.data}
				>
					<WalletCards data-icon="inline-start" />
					Top up
				</Button>
				{wallet.data ? <TopUpDialog open={topUpOpen} onOpenChange={setTopUpOpen} /> : null}
			</>
		);
	}
	if (target.kind === "start_new") {
		if (!startNewAction) return null;
		const icon =
			startNewIcon === "plus" ? (
				<Plus data-icon="inline-start" />
			) : (
				<Settings data-icon="inline-start" />
			);
		return startNewAction.kind === "link" ? (
			<Button
				data-hosted="true"
				render={<a href={startNewAction.href} />}
				nativeButton={false}
				type="button"
				size="sm"
				variant={variant}
				disabled={disabled}
			>
				{icon}
				{startNewAction.label}
			</Button>
		) : (
			<Button
				data-hosted="true"
				type="button"
				size="sm"
				variant={variant}
				onClick={startNewAction.onClick}
				disabled={disabled}
			>
				{icon}
				{startNewAction.label}
			</Button>
		);
	}
	return (
		<Button
			data-hosted="true"
			type="button"
			size="sm"
			variant={variant}
			onClick={() => void runAction(openPaymentRecovery)}
			disabled={disabled || fixPayment.isPending}
		>
			{fixPayment.isPending ? (
				<Spinner data-icon="inline-start" />
			) : target.kind === "invoice" ? (
				<ExternalLink data-icon="inline-start" />
			) : (
				<CreditCard data-icon="inline-start" />
			)}
			Fix payment
		</Button>
	);
}
