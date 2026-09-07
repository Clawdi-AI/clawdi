import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMemoryMib } from "@/lib/format";
import { cn } from "@/lib/utils";

type ComputeFact = { label: string | null; value: ReactNode };

/** Specs and commercial facts share one label/value track, including while loading. */
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
	const rows: ComputeFact[] = [
		{ label: "CPU", value: resources ? `${resources.vcpu} vCPU` : null },
		{ label: "Memory", value: resources ? formatMemoryMib(resources.memory_mib) : null },
		{ label: "Storage", value: resources ? `${resources.disk_gib} GiB` : null },
	];
	const commercial = loading
		? [
				{ label: "Subscription", value: null },
				{ label: "Next renewal", value: null },
			]
		: [subscription, date].filter((fact): fact is ComputeFact => Boolean(fact));
	return (
		<div
			className="space-y-1.5"
			data-testid="overview-compute-summary"
			aria-busy={loading || undefined}
		>
			<div data-overview-compute-plan className="text-sm text-muted-foreground">
				{loading ? <Skeleton className="h-lh w-32 max-w-full" /> : planLabel}
			</div>
			<dl
				aria-label="Compute resources"
				className="grid grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-4 gap-y-0.5 text-xs text-muted-foreground"
			>
				{[...rows, ...commercial].map((item, index) => (
					<div
						key={item.label ?? "access"}
						className={cn(
							"col-span-full grid grid-cols-subgrid items-baseline",
							loading && "items-center",
							index === rows.length && "mt-2",
						)}
						data-overview-subscription-row={index === rows.length || undefined}
					>
						<dt className={item.label ? "min-w-0 break-words" : "sr-only"}>
							{loading && index >= rows.length ? (
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
									? "flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 break-words"
									: "col-span-full flex min-w-0 flex-wrap items-center justify-between gap-3 break-words"
							}
						>
							<span
								data-overview-subscription-status={index === rows.length || undefined}
								className="min-w-0"
							>
								{loading ? <Skeleton className="h-lh w-16 max-w-full" /> : item.value}
							</span>
							{index === rows.length ? action : null}
						</dd>
					</div>
				))}
			</dl>
		</div>
	);
}
