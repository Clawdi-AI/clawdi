import { Link } from "@tanstack/react-router";
import { ArrowUp, CircleCheck, Settings, UserRoundX } from "lucide-react";
import type { ReactNode } from "react";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { entityCardChassisClass } from "@/components/entity-card";
import { Button } from "@/components/ui/button";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { billingTermSuffix, formatCurrencyCents } from "@/hosted/billing/format";
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
	| { kind: "available"; label: string }
	| { kind: "unavailable"; label: string };

export type ComputeSubscriptionCardView = {
	status: { label: string; tone: StatusTone };
	plan: string;
	commercialFacts: readonly { label: string; value: string; emphasis?: boolean }[];
};

export type ComputeSubscriptionPaymentSource = "included" | "stripe" | "wallet" | "unavailable";

export function computeSubscriptionPlanLabel(planSlug: string): string {
	if (planSlug === "compute_basic" || planSlug === "compute_performance") {
		return `${computeTierLabel(planSlug)} compute`;
	}
	return planSlug.replace(/^compute_/, "").replaceAll("_", " ");
}

export function computeSubscriptionCardView({
	status,
	planSlug,
	fundingSource,
	priceCents,
	currency,
	billingTermMonths,
	scheduleVerb,
	scheduleAt,
	scheduleFallback,
	includeSchedule = true,
}: {
	status: ComputeSubscriptionCardView["status"];
	planSlug: string;
	fundingSource: ComputeSubscriptionPaymentSource;
	priceCents: number | null | undefined;
	currency: string;
	billingTermMonths: number;
	scheduleVerb: string | null;
	scheduleAt: string | null | undefined;
	scheduleFallback?: string;
	includeSchedule?: boolean;
}): ComputeSubscriptionCardView {
	const included = fundingSource === "included";
	const schedule =
		scheduleVerb && scheduleAt
			? `${scheduleVerb} ${formatShortDate(scheduleAt)}`
			: scheduleFallback || "Unavailable";
	return {
		status,
		plan: computeSubscriptionPlanLabel(planSlug),
		commercialFacts: included
			? [{ label: "Price", value: "Free", emphasis: true }]
			: [
					{
						label: "Price",
						value:
							priceCents == null
								? "Unavailable"
								: `${formatCurrencyCents(priceCents, currency)}${billingTermSuffix(billingTermMonths)}`,
					},
					{
						label: "Payment",
						value:
							fundingSource === "wallet"
								? "Wallet"
								: fundingSource === "stripe"
									? "Card"
									: "Unavailable",
					},
					...(includeSchedule ? [{ label: "Schedule", value: schedule }] : []),
				],
	};
}

function SubscriptionIdentity({ identity }: { identity: ComputeSubscriptionIdentity }) {
	if (identity.kind === "available") {
		return (
			<div className="flex min-w-0 items-center gap-3 text-success-muted-foreground">
				<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-success-muted">
					<CircleCheck className="size-3.5" aria-hidden />
				</span>
				<span className="truncate text-sm font-medium" title={identity.label}>
					{identity.label}
				</span>
			</div>
		);
	}
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

	const label = (
		<AgentLabel
			name={identity.name}
			machineName={null}
			type={identity.agentType}
			avatarUrl={identity.avatarUrl}
			size="md"
			className={cn("min-w-0", identity.href && "transition-opacity hover:opacity-80")}
		/>
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

export function ComputeSubscriptionPlanAction({
	action,
	onClick,
	disabled = false,
}: {
	action: "upgrade" | "manage";
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onClick}>
			{action === "upgrade" ? (
				<ArrowUp data-icon="inline-start" />
			) : (
				<Settings data-icon="inline-start" />
			)}
			{action === "upgrade" ? "Upgrade" : "Manage"}
		</Button>
	);
}

export function ComputeSubscriptionCard({
	view,
	identity,
	badges,
	notice,
	actions,
	actionsId,
	headingLevel = 3,
	className,
}: {
	view: ComputeSubscriptionCardView;
	identity?: ComputeSubscriptionIdentity;
	badges?: ReactNode;
	notice?: ReactNode;
	actions?: ReactNode;
	actionsId?: string;
	headingLevel?: 3 | 4;
	className?: string;
}) {
	const Heading = headingLevel === 4 ? "h4" : "h3";

	return (
		<article
			data-hosted="true"
			data-slot="compute-subscription-card"
			data-subscription-status={view.status.label.toLowerCase().replaceAll(" ", "-")}
			className={entityCardChassisClass({
				variant: "compact",
				className: cn("@container/subscription flex h-full min-w-0 flex-col gap-3", className),
			})}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<header
					data-slot="compute-subscription-header"
					className="flex min-h-6 min-w-0 flex-wrap items-start gap-x-3 gap-y-1.5 sm:min-h-12 @md/subscription:min-h-6"
				>
					<Heading className="min-w-28 flex-1 basis-28 text-base font-semibold leading-6 [overflow-wrap:anywhere]">
						{view.plan}
					</Heading>
					<div className="ml-auto flex max-w-full shrink-0 flex-wrap justify-end gap-1.5">
						<StatusBadge status={view.status.tone} withDot>
							{view.status.label}
						</StatusBadge>
						{badges}
					</div>
				</header>

				<dl
					data-slot="compute-subscription-meta"
					className="flex min-h-5 min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1.5 sm:min-h-12 @md/subscription:min-h-5"
				>
					{view.commercialFacts.map((fact) => (
						<div key={fact.label} className="min-w-0 text-xs leading-5 text-muted-foreground">
							<dt className="sr-only">{fact.label}</dt>
							<dd
								className={cn(
									"[overflow-wrap:anywhere]",
									fact.emphasis && "font-semibold text-foreground",
								)}
							>
								{fact.value}
							</dd>
						</div>
					))}
				</dl>

				<div
					data-slot="compute-subscription-identity"
					className="flex min-h-5 min-w-0 items-center gap-3"
				>
					{identity ? (
						<>
							{identity.kind === "agent" ? (
								<span className="shrink-0 text-xs text-muted-foreground">Used by</span>
							) : null}
							<div className="min-w-0 flex-1">
								<SubscriptionIdentity identity={identity} />
							</div>
						</>
					) : null}
				</div>
			</div>

			<div
				data-slot="compute-subscription-footer"
				className="mt-auto flex min-w-0 flex-col items-start gap-1.5 pt-1 sm:items-end"
			>
				{notice ? (
					<div data-slot="compute-subscription-notice" className="min-w-0 sm:text-right">
						{notice}
					</div>
				) : null}
				<div
					id={actionsId}
					data-slot="compute-subscription-actions"
					className="flex min-h-8 min-w-0 w-full flex-wrap items-center gap-2 sm:justify-end max-sm:[&_[data-slot=button]]:h-auto max-sm:[&_[data-slot=button]]:min-h-8 max-sm:[&_[data-slot=button]]:max-w-full max-sm:[&_[data-slot=button]]:whitespace-normal"
				>
					{actions}
				</div>
			</div>
		</article>
	);
}
