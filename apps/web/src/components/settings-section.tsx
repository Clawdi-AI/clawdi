import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export function SettingsSection({
	title,
	description,
	children,
	className,
	tone = "default",
}: {
	title: string;
	description?: string;
	children: React.ReactNode;
	className?: string;
	tone?: "default" | "danger";
}) {
	return (
		<section className={cn("grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-x-10", className)}>
			<Separator className="lg:col-span-2" />
			<div className="flex max-w-sm flex-col gap-1.5">
				<div className={cn("text-sm font-semibold", tone === "danger" && "text-destructive")}>
					{title}
				</div>
				{description ? (
					<p className="text-sm leading-5 text-muted-foreground">{description}</p>
				) : null}
			</div>
			<div className="min-w-0">{children}</div>
		</section>
	);
}
