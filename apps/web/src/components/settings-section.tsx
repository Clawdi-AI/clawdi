import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/** Flat form/settings section; use SectionLabel for list-group captions and DashboardSection for bordered content containers. */
export function SettingsSection({
	title,
	description,
	children,
	className,
	variant = "default",
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	children: React.ReactNode;
	className?: string;
	variant?: "default" | "destructive";
}) {
	return (
		<section className={cn("flex flex-col gap-4", className)}>
			<Separator />
			<div className="flex max-w-2xl flex-col gap-1.5">
				<div
					className={cn("text-sm font-semibold", variant === "destructive" && "text-destructive")}
				>
					{title}
				</div>
				{description ? (
					<div className="text-sm leading-5 text-muted-foreground">{description}</div>
				) : null}
			</div>
			<div className="min-w-0">{children}</div>
		</section>
	);
}
