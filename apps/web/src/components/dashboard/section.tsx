import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
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
				"-mx-4 overflow-hidden border-y bg-card/60 sm:mx-0 sm:rounded-lg sm:border",
				priority === "primary" && "border-foreground/15 bg-card",
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
				"flex flex-col gap-3 border-b px-4 py-4 sm:flex-row sm:items-start sm:justify-between",
				priority === "quiet" && "bg-muted/15",
				priority === "primary" && "bg-muted/25",
			)}
		>
			<div className="min-w-0 space-y-1">
				<div className="flex min-w-0 items-center gap-2">
					<Icon className="size-4 shrink-0 text-muted-foreground" />
					<h2 className="truncate text-sm font-semibold">{title}</h2>
					{count !== undefined ? (
						<Badge variant="secondary" className="text-xs tabular-nums">
							{count}
						</Badge>
					) : null}
				</div>
				<p className="max-w-3xl text-xs text-muted-foreground">{description}</p>
			</div>
			{actions ? (
				<div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-0 sm:flex-row sm:items-center">
					{actions}
				</div>
			) : null}
		</div>
	);
}

export function DashboardSectionToolbar({ children }: { children: ReactNode }) {
	return <div className="border-b bg-background/40 px-4 py-3">{children}</div>;
}

export function DashboardEmptyLine({ title, message }: { title: string; message: ReactNode }) {
	return (
		<div className="m-4 rounded-lg border border-dashed px-4 py-6">
			<div className="space-y-1">
				<h3 className="text-sm font-medium">{title}</h3>
				<p className="max-w-2xl text-sm text-muted-foreground">{message}</p>
			</div>
		</div>
	);
}
