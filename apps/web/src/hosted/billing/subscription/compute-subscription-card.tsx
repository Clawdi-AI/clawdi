import { Link } from "@tanstack/react-router";
import { UserRoundX } from "lucide-react";
import type { ReactNode } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { billingTermLabel, billingTermSuffix, formatCurrencyCents } from "@/hosted/billing/format";
import { computeTierLabel } from "@/hosted/billing/subscription/subscription-utils";
import { formatShortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ComputeSubscriptionIdentity =
	| {
			kind: "agent";
			name: string;
			agentType: string | null;
			avatarUrl?: string | null;
			href?: string;
	  }
	| { kind: "unavailable"; label: string };

export type ComputeSubscriptionCardView = {
	identity: ComputeSubscriptionIdentity;
	status: { label: string; tone: StatusTone };
	facts: readonly [
		{ label: "Plan"; value: string },
		{ label: "Payment"; value: string },
		{ label: "Price"; value: string; meta: string },
		{ label: "Schedule"; value: string },
	];
};

export type ComputeSubscriptionPaymentSource = "included" | "stripe" | "wallet" | "unavailable";

export function computeSubscriptionPlanLabel(planSlug: string): string {
	if (planSlug === "compute_basic" || planSlug === "compute_performance") {
		return `${computeTierLabel(planSlug)} compute`;
	}
	return planSlug.replace(/^compute_/, "").replaceAll("_", " ");
}

export function computeSubscriptionCardView({
	identity,
	status,
	planSlug,
	fundingSource,
	priceCents,
	currency,
	billingTermMonths,
	scheduleVerb,
	scheduleAt,
}: {
	identity: ComputeSubscriptionIdentity;
	status: ComputeSubscriptionCardView["status"];
	planSlug: string;
	fundingSource: ComputeSubscriptionPaymentSource;
	priceCents: number | null | undefined;
	currency: string;
	billingTermMonths: number;
	scheduleVerb: string | null;
	scheduleAt: string | null | undefined;
}): ComputeSubscriptionCardView {
	const included = fundingSource === "included";
	return {
		identity,
		status,
		facts: [
			{ label: "Plan", value: computeSubscriptionPlanLabel(planSlug) },
			{
				label: "Payment",
				value:
					fundingSource === "included"
						? "Included"
						: fundingSource === "wallet"
							? "Wallet"
							: fundingSource === "stripe"
								? "Card"
								: "Unavailable",
			},
			{
				label: "Price",
				value:
					included || priceCents === 0
						? "No charge"
						: priceCents == null
							? "Unavailable"
							: `${formatCurrencyCents(priceCents, currency)}${billingTermSuffix(billingTermMonths)}`,
				meta: included ? "Included plan" : billingTermLabel(billingTermMonths),
			},
			{
				label: "Schedule",
				value:
					scheduleVerb && scheduleAt
						? `${scheduleVerb} ${formatShortDate(scheduleAt)}`
						: included
							? "Current"
							: "Unavailable",
			},
		],
	};
}

function SubscriptionIdentity({ identity }: { identity: ComputeSubscriptionIdentity }) {
	if (identity.kind === "unavailable") {
		return (
			<div className="flex min-w-0 items-center gap-3 text-muted-foreground">
				<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted">
					<UserRoundX className="size-3.5" aria-hidden />
				</span>
				<span className="truncate text-sm font-medium" title={identity.label}>
					{identity.label}
				</span>
			</div>
		);
	}

	const label = identity.agentType ? (
		<AgentLabel
			name={identity.name}
			machineName={null}
			type={identity.agentType}
			avatarUrl={identity.avatarUrl}
			size="md"
			className={cn("min-w-0", identity.href && "transition-opacity hover:opacity-80")}
		/>
	) : (
		<div className="flex min-w-0 items-center gap-3">
			<AgentIcon agent={null} size="md" avatarUrl={identity.avatarUrl} />
			<span className="truncate text-sm font-medium" title={identity.name}>
				{identity.name}
			</span>
		</div>
	);

	return identity.href ? (
		<Link
			to={identity.href}
			className="min-w-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{label}
		</Link>
	) : (
		<div className="min-w-0">{label}</div>
	);
}

export function ComputeSubscriptionCard({
	view,
	badges,
	notice,
	actions,
	headingLevel = 3,
	className,
}: {
	view: ComputeSubscriptionCardView;
	badges?: ReactNode;
	notice?: ReactNode;
	actions?: ReactNode;
	headingLevel?: 3 | 4;
	className?: string;
}) {
	const Heading = headingLevel === 4 ? "h4" : "h3";
	const plan = view.facts[0];
	const identityLabel = view.identity.kind === "agent" ? view.identity.name : view.identity.label;

	return (
		<article
			data-hosted="true"
			data-slot="compute-subscription-card"
			data-subscription-status={view.status.label.toLowerCase().replaceAll(" ", "-")}
			className={cn(
				"flex h-full min-w-0 flex-col overflow-hidden rounded-lg border bg-card",
				className,
			)}
		>
			<Heading className="sr-only">{`${identityLabel}: ${plan.value}`}</Heading>
			<header className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3.5">
				<SubscriptionIdentity identity={view.identity} />
				<div className="flex min-w-0 flex-wrap justify-end gap-1.5">
					<StatusBadge status={view.status.tone} withDot>
						{view.status.label}
					</StatusBadge>
					{badges}
				</div>
			</header>

			<dl className="grid min-w-0 grid-cols-2 border-t">
				{view.facts.map((fact, index) => (
					<div
						key={fact.label}
						className={cn(
							"min-w-0 px-4 py-3",
							index % 2 === 1 && "border-l",
							index >= 2 && "border-t",
						)}
					>
						<dt className="text-xs text-muted-foreground">{fact.label}</dt>
						<dd className="mt-0.5 min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
							{fact.value}
						</dd>
						{"meta" in fact ? (
							<span className="mt-0.5 block text-xs text-muted-foreground">{fact.meta}</span>
						) : null}
					</div>
				))}
			</dl>

			{notice ? (
				<div data-slot="compute-subscription-notice" className="min-w-0 border-t px-4 py-2.5">
					{notice}
				</div>
			) : null}
			{actions ? (
				<div
					data-slot="compute-subscription-actions"
					className="mt-auto flex min-w-0 flex-wrap items-center justify-end gap-2 border-t bg-muted/15 px-3 py-2"
				>
					{actions}
				</div>
			) : null}
		</article>
	);
}
