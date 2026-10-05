import { overviewComputeBodyClasses } from "@clawdi/shared/ui";
import { overviewComputeSummaryCopy as copy, overviewComputeSpecs } from "@clawdi/shared/view";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type ComputeFact = { label: string | null; value: ReactNode };

/** Inline specs and billing facts keep their own space above optional actions. */
export function OverviewComputeBody({
	planLabel,
	resources,
	subscription,
	date,
	action,
	loading = false,
}: {
	planLabel?: string;
	resources?: { vcpu: number; memory_mib: number; disk_gib: number };
	subscription?: ComputeFact | null;
	date?: ComputeFact | null;
	action?: ReactNode;
	loading?: boolean;
}) {
	const specs = overviewComputeSpecs(resources);
	const commercial = loading
		? [
				{ label: copy.subscription, value: null },
				{ label: copy.nextRenewal, value: null },
			]
		: [subscription, date].filter((fact): fact is ComputeFact => Boolean(fact));
	return (
		<div
			className={overviewComputeBodyClasses.root}
			data-testid="overview-compute-summary"
			aria-busy={loading || undefined}
		>
			<div data-overview-compute-plan className={overviewComputeBodyClasses.plan}>
				{loading ? <Skeleton className={overviewComputeBodyClasses.planSkeleton} /> : planLabel}
			</div>
			<dl aria-label={copy.resources} className={overviewComputeBodyClasses.specs}>
				{specs.map((item, index) => (
					<div key={item.label}>
						<dt className={overviewComputeBodyClasses.screenReaderOnly}>{item.label}</dt>
						<dd className={overviewComputeBodyClasses.specValue}>
							{index > 0 && <span aria-hidden="true">·</span>}
							{loading ? (
								<Skeleton
									className={cn(
										overviewComputeBodyClasses.specSkeleton,
										overviewComputeBodyClasses[`${item.key}Skeleton`],
									)}
								/>
							) : (
								<span>{item.value}</span>
							)}
						</dd>
					</div>
				))}
			</dl>
			{commercial.length > 0 && (
				<dl className={overviewComputeBodyClasses.commercial}>
					{commercial.map((item, index) => (
						<div
							key={item.label ?? "access"}
							className={cn(
								overviewComputeBodyClasses.commercialRow,
								loading && overviewComputeBodyClasses.commercialLoadingRow,
							)}
							data-overview-subscription-row={index === 0 || undefined}
						>
							<dt
								className={
									item.label
										? overviewComputeBodyClasses.commercialLabel
										: overviewComputeBodyClasses.screenReaderOnly
								}
							>
								{loading ? (
									<Skeleton className={overviewComputeBodyClasses.commercialLabelSkeleton}>
										<span className={overviewComputeBodyClasses.skeletonLabel} aria-hidden="true">
											{item.label}
										</span>
									</Skeleton>
								) : (
									(item.label ?? copy.planAccess)
								)}
							</dt>
							<dd
								className={
									item.label
										? overviewComputeBodyClasses.commercialValue
										: overviewComputeBodyClasses.commercialAccess
								}
							>
								<span
									data-overview-subscription-status={index === 0 || undefined}
									className={overviewComputeBodyClasses.commercialStatus}
								>
									{loading ? (
										<Skeleton className={overviewComputeBodyClasses.commercialStatusSkeleton} />
									) : (
										item.value
									)}
								</span>
							</dd>
						</div>
					))}
				</dl>
			)}
			{action && <div className={overviewComputeBodyClasses.actions}>{action}</div>}
		</div>
	);
}
