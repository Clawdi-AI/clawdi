import type { HostedDeployment, WalletState } from "@/hosted/billing/contracts";
import { computeTierLabel } from "@/hosted/billing/subscription/subscription-utils";

export type WalletFundedDeployment = {
	deploymentId: string;
	name: string;
	planLabel: "Basic" | "Performance";
	priceCents: number;
	renews: boolean;
	nextRenewalAt: string | null;
	status: string;
};

export type WalletComputeCoverage = {
	deployments: WalletFundedDeployment[];
	totalMonthlyCents: number;
	balanceValueCents: number;
	coverageMonths: number | null;
	lowCoverage: boolean;
};

export function decimalCredits(value: string | number | null | undefined): number {
	const parsed = typeof value === "number" ? value : Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function walletComputeCoverage(
	wallet: Pick<WalletState, "balance_credits" | "points_per_usd" | "auto_reload_enabled">,
	deployments: readonly HostedDeployment[] | undefined,
): WalletComputeCoverage {
	const funded: WalletFundedDeployment[] = [];
	for (const deployment of deployments ?? []) {
		const subscription = deployment.compute_subscription;
		if (subscription?.funding_source !== "wallet") continue;
		funded.push({
			deploymentId: deployment.id,
			name: deployment.name,
			planLabel: computeTierLabel(deployment.config_info?.compute_plan_slug),
			priceCents: Math.max(0, subscription.price_cents ?? 0),
			renews: !subscription.cancel_at_period_end && subscription.status !== "canceled",
			nextRenewalAt: subscription.current_period_end ?? null,
			status: subscription.payment_state,
		});
	}
	funded.sort((left, right) => {
		const leftTime = left.nextRenewalAt ? Date.parse(left.nextRenewalAt) : Number.POSITIVE_INFINITY;
		const rightTime = right.nextRenewalAt
			? Date.parse(right.nextRenewalAt)
			: Number.POSITIVE_INFINITY;
		return leftTime - rightTime;
	});
	const totalMonthlyCents = funded.reduce(
		(sum, deployment) => sum + (deployment.renews ? deployment.priceCents : 0),
		0,
	);
	const balanceValueCents = wallet.points_per_usd
		? Math.max(0, (wallet.balance_credits / wallet.points_per_usd) * 100)
		: 0;
	const coverageMonths = totalMonthlyCents > 0 ? balanceValueCents / totalMonthlyCents : null;
	return {
		deployments: funded,
		totalMonthlyCents,
		balanceValueCents,
		coverageMonths,
		lowCoverage: !wallet.auto_reload_enabled && coverageMonths !== null && coverageMonths < 1,
	};
}
