import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Informational banner — a tinted icon tile beside a title + description. The
 * static "here's how this works" card shared across hosted surfaces (channel
 * detail tabs, agent detail). `children` is the description body, so it may
 * carry inline links or interpolated copy.
 */
export function InfoCard({
	icon: Icon,
	title,
	children,
}: {
	icon: LucideIcon;
	title: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="rounded-lg border bg-card p-4">
			<div className="flex items-start gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
					<Icon className="size-5" />
				</span>
				<div className="min-w-0 flex-1 space-y-1">
					<div className="text-sm font-medium">{title}</div>
					<p className="text-sm text-muted-foreground">{children}</p>
				</div>
			</div>
		</div>
	);
}
