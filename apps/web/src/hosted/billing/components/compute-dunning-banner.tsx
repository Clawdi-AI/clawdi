"use client";

import { CreditCard, ExternalLink, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { normalizeBillingError } from "@/hosted/billing/errors";
import { useFixPayment } from "@/hosted/billing/hooks";
import { formatShortDate } from "@/lib/format";
import { computeDunningState } from "./compute-dunning.logic";

export function ComputeDunningBanner({ deployment }: { deployment: HostedDeployment }) {
	const state = computeDunningState(deployment);
	const fixPayment = useFixPayment();
	if (!state) return null;

	const riskLabel = state.nextPaymentAttemptAt
		? `Next retry: ${formatShortDate(state.nextPaymentAttemptAt)}.`
		: state.serviceRiskAt && state.paymentState !== "unpaid"
			? `Service is at risk after ${formatShortDate(state.serviceRiskAt)}.`
			: null;
	const destructive = state.paymentState === "unpaid";

	async function handleFixPayment() {
		if (!state) return;
		if (state.ctaTarget === "invoice" && state.invoiceUrl) {
			window.location.href = state.invoiceUrl;
			return;
		}
		try {
			const res = await fixPayment.mutateAsync({ deployment_id: deployment.id });
			const url = res.url || res.portal_url;
			if (url) {
				window.location.href = url;
				return;
			}
			toast.message("Payment update unavailable", {
				description: res.message ?? "Please try again in a moment.",
			});
		} catch (error) {
			toast.error("Couldn’t open payment settings", {
				description: normalizeBillingError(error),
			});
		}
	}

	return (
		<Alert
			data-hosted="true"
			variant={destructive ? "destructive" : "default"}
			className={destructive ? undefined : "border-warning/30 bg-warning-muted"}
		>
			<TriangleAlert />
			<AlertTitle>{state.title}</AlertTitle>
			<AlertDescription className="flex flex-col items-start gap-3">
				<span>
					{state.description}
					{riskLabel ? ` ${riskLabel}` : ""}
				</span>
				<Button
					size="sm"
					variant={destructive ? "destructive" : "default"}
					onClick={() => {
						void handleFixPayment();
					}}
					disabled={fixPayment.isPending && state.ctaTarget === "portal"}
				>
					{fixPayment.isPending && state.ctaTarget === "portal" ? (
						<Spinner />
					) : state.ctaTarget === "invoice" ? (
						<ExternalLink data-icon="inline-start" />
					) : (
						<CreditCard data-icon="inline-start" />
					)}
					Fix payment
				</Button>
			</AlertDescription>
		</Alert>
	);
}
