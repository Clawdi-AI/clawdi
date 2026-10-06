import { sectionClasses } from "@clawdi/shared/ui";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type DashboardSectionPriority = "primary" | "secondary" | "quiet";

export function DashboardSection({
	children,
	priority = "secondary",
	className,
}: {
	children: ReactNode;
	priority?: DashboardSectionPriority;
	className?: string;
}) {
	return (
		<section
			className={cn(
				sectionClasses.root,
				priority === "primary" && sectionClasses.primary,
				className,
			)}
		>
			{children}
		</section>
	);
}

export function DashboardSectionHeader({
	icon: Icon,
	title,
	count,
	description,
	actions,
	priority = "secondary",
}: {
	icon: LucideIcon;
	title: string;
	count?: ReactNode;
	description: ReactNode;
	actions?: ReactNode;
	priority?: DashboardSectionPriority;
}) {
	return (
		<div
			className={cn(
				sectionClasses.header,
				priority === "quiet" && sectionClasses.quietHeader,
				priority === "primary" && sectionClasses.primaryHeader,
			)}
		>
			<div className={sectionClasses.headerBody}>
				<div className={sectionClasses.titleRow}>
					<Icon className={sectionClasses.icon} />
					<h2 className={sectionClasses.title}>{title}</h2>
					{count !== undefined ? (
						<Badge variant="secondary" className={sectionClasses.count}>
							{count}
						</Badge>
					) : null}
				</div>
				<p className={sectionClasses.description}>{description}</p>
			</div>
			{actions ? <div className={sectionClasses.actions}>{actions}</div> : null}
		</div>
	);
}

export function DashboardSectionToolbar({ children }: { children: ReactNode }) {
	return <div className={sectionClasses.toolbar}>{children}</div>;
}

export function DashboardEmptyLine({ title, message }: { title: string; message: ReactNode }) {
	return (
		<EmptyState
			variant="inset"
			title={title}
			description={message}
			className={sectionClasses.empty}
		/>
	);
}
