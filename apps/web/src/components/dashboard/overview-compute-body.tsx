import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMemoryMib } from "@/lib/format";
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
	const specs = [
		{ label: "CPU", value: resources ? `${resources.vcpu} vCPU` : null, width: "w-10" },
		{
			label: "Memory",
			value: resources ? `${formatMemoryMib(resources.memory_mib)} RAM` : null,
			width: "w-16",
		},
		{
			label: "Storage",
			value: resources ? `${resources.disk_gib} GiB storage` : null,
			width: "w-20",
		},
	];
	const commercial = loading
		? [
				{ label: "Subscription", value: null },
				{ label: "Next renewal", value: null },
			]
		: [subscription, date].filter((fact): fact is ComputeFact => Boolean(fact));
	return (
		<div
			className="space-y-2"
			data-testid="overview-compute-summary"
			aria-busy={loading || undefined}
		>
			<div data-overview-compute-plan className="text-sm text-muted-foreground">
				{loading ? <Skeleton className="h-lh w-32 max-w-full" /> : planLabel}
			</div>
			<dl
				aria-label="Compute resources"
				className="flex flex-wrap gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
			>
				{specs.map((item, index) => (
					<div key={item.label}>
						<dt className="sr-only">{item.label}</dt>
						<dd className="flex items-center gap-1.5">
							{index > 0 && <span aria-hidden="true">·</span>}
							{loading ? (
								<Skeleton className={cn("h-lh max-w-full", item.width)} />
							) : (
								<span>{item.value}</span>
							)}
						</dd>
					</div>
				))}
			</dl>
			{commercial.length > 0 && (
				<dl className="space-y-1 text-xs text-muted-foreground">
					{commercial.map((item, index) => (
						<div
							key={item.label ?? "access"}
							className={cn(
								"grid grid-cols-[fit-content(40%)_minmax(0,1fr)] items-baseline gap-x-4",
								loading && "items-center",
							)}
							data-overview-subscription-row={index === 0 || undefined}
						>
							<dt className={item.label ? "min-w-0 break-words" : "sr-only"}>
								{loading ? (
									<Skeleton className="relative h-lh max-w-full">
										<span className="invisible" aria-hidden="true">
											{item.label}
										</span>
									</Skeleton>
								) : (
									(item.label ?? "Plan access")
								)}
							</dt>
							<dd
								className={
									item.label
										? "min-w-0 text-right break-words"
										: "col-span-full min-w-0 break-words"
								}
							>
								<span
									data-overview-subscription-status={index === 0 || undefined}
									className="inline-block max-w-full align-top"
								>
									{loading ? <Skeleton className="h-lh w-16 max-w-full" /> : item.value}
								</span>
							</dd>
						</div>
					))}
				</dl>
			)}
			{action && <div className="flex flex-wrap justify-end gap-2 pt-1">{action}</div>}
		</div>
	);
}
