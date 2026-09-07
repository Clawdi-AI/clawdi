import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AgentOverviewTools({ children }: { children: ReactNode }) {
	return (
		<div className="grid auto-rows-fr gap-3 @5xl/main:grid-cols-3" data-overview-section="tools">
			{children}
		</div>
	);
}

export function AgentOverviewSectionHeading({
	children,
	action,
}: {
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="flex min-h-8 items-center justify-between gap-3" data-overview-heading>
			{children}
			{action}
		</div>
	);
}

export function AgentOverviewActivity({
	heading,
	action,
	sessions,
	children,
}: {
	heading: ReactNode;
	action: ReactNode;
	sessions: ReactNode;
	children: ReactNode;
}) {
	return (
		<div
			className="grid items-stretch gap-4 @3xl/main:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] @3xl/main:gap-y-3"
			data-overview-section="entry"
		>
			{sessions ? (
				<div
					className="grid min-w-0 gap-3 @3xl/main:row-span-2 @3xl/main:row-start-1 @3xl/main:grid-rows-subgrid"
					data-overview-section="activity"
				>
					<AgentOverviewSectionHeading action={action}>{heading}</AgentOverviewSectionHeading>
					{sessions}
				</div>
			) : null}
			<div className={cn("min-w-0", sessions && "@3xl/main:row-start-2")}>{children}</div>
		</div>
	);
}
