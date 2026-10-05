import { computeSubscriptionCardClasses } from "@clawdi/shared/ui";
import { billingCopy } from "@clawdi/shared/view";
import { Link } from "@tanstack/react-router";
import { ArrowUp, CircleCheck, Settings, UserRoundX } from "lucide-react";
import type { ReactNode } from "react";
import { AgentLabel } from "@/components/dashboard/agent-label";
import { entityCardChassisClass } from "@/components/entity-card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
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

export { computeSubscriptionCardView, computeSubscriptionPlanLabel } from "@clawdi/shared/view";

import type { ComputeSubscriptionCardView } from "@clawdi/shared/view";

export type {
	ComputeSubscriptionCardView,
	ComputeSubscriptionPaymentSource,
} from "@clawdi/shared/view";

function SubscriptionIdentity({ identity }: { identity: ComputeSubscriptionIdentity }) {
	if (identity.kind === "available") {
		return (
			<div className={computeSubscriptionCardClasses.includedIdentity}>
				<span className={computeSubscriptionCardClasses.includedIconTile}>
					<CircleCheck className={computeSubscriptionCardClasses.icon} aria-hidden />
				</span>
				<span className={computeSubscriptionCardClasses.identityLabel} title={identity.label}>
					{identity.label}
				</span>
			</div>
		);
	}
	if (identity.kind === "unavailable") {
		return (
			<div className={computeSubscriptionCardClasses.orphanIdentity}>
				<span className={computeSubscriptionCardClasses.orphanIconTile}>
					<UserRoundX className={computeSubscriptionCardClasses.icon} aria-hidden />
				</span>
				<span className={computeSubscriptionCardClasses.identityLabel} title={identity.label}>
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
		<Link to={identity.href} className={computeSubscriptionCardClasses.agentLink}>
			{label}
		</Link>
	) : (
		<div className={computeSubscriptionCardClasses.minWidth}>{label}</div>
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
				className: cn(computeSubscriptionCardClasses.notices, className),
			})}
		>
			<header
				data-slot="compute-subscription-header"
				className={computeSubscriptionCardClasses.heading}
			>
				<Heading className={computeSubscriptionCardClasses.planName}>{view.plan}</Heading>
				<div className={computeSubscriptionCardClasses.badges}>
					<StatusBadge status={view.status.tone} withDot>
						{view.status.label}
					</StatusBadge>
					{badges}
				</div>
			</header>

			<dl data-slot="compute-subscription-meta" className={computeSubscriptionCardClasses.meta}>
				{view.commercialFacts.map((fact) => (
					<div key={fact.label} className={computeSubscriptionCardClasses.metaText}>
						<dt className={computeSubscriptionCardClasses.screenReader}>{fact.label}</dt>
						<dd
							className={cn(
								"[overflow-wrap:anywhere]",
								fact.emphasis && computeSubscriptionCardClasses.noticeStrong,
							)}
						>
							{fact.value}
						</dd>
					</div>
				))}
			</dl>

			<div
				data-slot="compute-subscription-identity"
				className={computeSubscriptionCardClasses.footer}
			>
				{identity ? (
					<>
						{identity.kind === "agent" ? (
							<span className={computeSubscriptionCardClasses.hint}>{billingCopy.usedBy}</span>
						) : null}
						<div className={computeSubscriptionCardClasses.identity}>
							<SubscriptionIdentity identity={identity} />
						</div>
					</>
				) : null}
			</div>

			{notice ? (
				<div
					data-slot="compute-subscription-notice"
					className={computeSubscriptionCardClasses.price}
				>
					{notice}
				</div>
			) : null}
			<div
				id={actionsId}
				data-slot="compute-subscription-actions"
				className={computeSubscriptionCardClasses.actions}
			>
				{actions}
			</div>
		</article>
	);
}
