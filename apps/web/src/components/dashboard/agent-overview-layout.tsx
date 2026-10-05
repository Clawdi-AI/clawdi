import { agentOverviewLayoutClasses } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AgentOverviewTools({ children }: { children: ReactNode }) {
	return (
		<div className={agentOverviewLayoutClasses.tools} data-overview-section="tools">
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
		<div className={agentOverviewLayoutClasses.heading} data-overview-heading>
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
		<div className={agentOverviewLayoutClasses.entry} data-overview-section="entry">
			{sessions ? (
				<div className={agentOverviewLayoutClasses.activity} data-overview-section="activity">
					<AgentOverviewSectionHeading action={action}>{heading}</AgentOverviewSectionHeading>
					{sessions}
				</div>
			) : null}
			<div className={cn("min-w-0", sessions && "@3xl/main:row-start-2")}>{children}</div>
		</div>
	);
}
