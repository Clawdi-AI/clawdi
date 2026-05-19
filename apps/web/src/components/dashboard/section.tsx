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
				"overflow-hidden rounded-lg border bg-card/60",
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
	toolbar,
	priority = "secondary",
}: {
	icon: LucideIcon;
	title: string;
	count?: ReactNode;
	description: ReactNode;
	toolbar?: ReactNode;
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
					<span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
						<Icon className="size-3.5" />
					</span>
					<h2 className="truncate text-base font-semibold">{title}</h2>
					{count !== undefined ? (
						<Badge variant="secondary" className="text-xs">
							{count}
						</Badge>
					) : null}
				</div>
				<p className="max-w-3xl text-xs text-muted-foreground">{description}</p>
			</div>
			{toolbar ? (
				<div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-0 sm:flex-row sm:items-center">
					{toolbar}
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
