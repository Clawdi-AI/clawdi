import { agentOverviewLayoutClasses } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AgentOverviewTools({ children }: { children: ReactNode }) {
	return (
		<div className={agentOverviewLayoutClasses.gridAutoRowsFr} data-overview-section="tools">
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
		<div className={agentOverviewLayoutClasses.flexMinHItems} data-overview-heading>
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
		<div className={agentOverviewLayoutClasses.gridItemsStretchGap} data-overview-section="entry">
			{sessions ? (
				<div className={agentOverviewLayoutClasses.gridMinWGap} data-overview-section="activity">
					<AgentOverviewSectionHeading action={action}>{heading}</AgentOverviewSectionHeading>
					{sessions}
				</div>
			) : null}
			<div className={cn("min-w-0", sessions && "@3xl/main:row-start-2")}>{children}</div>
		</div>
	);
}
