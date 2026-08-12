import type { ReactNode } from "react";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

export type ComputeSubscriptionCardDetail = {
	label: string;
	value: ReactNode;
};

export function ComputeSubscriptionCard({
	title,
	status,
	description,
	badges,
	details,
	notice,
	actions,
	headingLevel = 3,
	className,
}: {
	title: ReactNode;
	status: { label: string; tone: StatusTone };
	description?: ReactNode;
	badges?: ReactNode;
	details?: readonly ComputeSubscriptionCardDetail[];
	notice?: ReactNode;
	actions?: ReactNode;
	headingLevel?: 3 | 4;
	className?: string;
}) {
	const Heading = headingLevel === 4 ? "h4" : "h3";

	return (
		<article
			data-hosted="true"
			data-slot="compute-subscription-card"
			className={cn("min-w-0 overflow-hidden rounded-lg border bg-card", className)}
		>
			<header className="flex min-w-0 flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0 flex-1">
					<Heading className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">
						{title}
					</Heading>
					{description ? (
						<div className="mt-1 min-w-0 text-xs leading-5 text-muted-foreground">
							{description}
						</div>
					) : null}
				</div>
				<div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5">
					<StatusBadge status={status.tone}>{status.label}</StatusBadge>
					{badges}
				</div>
			</header>

			{details?.length ? (
				<dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 border-t px-4 py-3 sm:[grid-template-columns:repeat(auto-fit,minmax(8rem,1fr))]">
					{details.map((detail) => (
						<div key={detail.label} className="min-w-0">
							<dt className="text-xs text-muted-foreground">{detail.label}</dt>
							<dd className="mt-0.5 min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
								{detail.value}
							</dd>
						</div>
					))}
				</dl>
			) : null}

			{notice ? (
				<div data-slot="compute-subscription-notice" className="min-w-0 border-t px-4 py-3">
					{notice}
				</div>
			) : null}
			{actions ? (
				<div
					data-slot="compute-subscription-actions"
					className="min-w-0 border-t bg-muted/20 px-4 py-3"
				>
					{actions}
				</div>
			) : null}
		</article>
	);
}
