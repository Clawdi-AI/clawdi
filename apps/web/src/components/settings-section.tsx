import { useId } from "react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type SettingsSectionProps = Omit<React.ComponentProps<"section">, "children" | "title"> & {
	title: React.ReactNode;
	description?: React.ReactNode;
	children?: React.ReactNode;
	variant?: "default" | "destructive";
	headingLevel?: 2 | 3;
};

/** Flat form/settings section; use SectionLabel for list-group captions and DashboardSection for bordered content containers. */
export function SettingsSection({
	title,
	description,
	children,
	className,
	variant = "default",
	headingLevel = 2,
	...sectionProps
}: SettingsSectionProps) {
	const generatedTitleId = useId();
	const titleId = sectionProps["aria-labelledby"] ?? generatedTitleId;
	const Heading = headingLevel === 3 ? "h3" : "h2";
	return (
		<section
			aria-labelledby={titleId}
			{...sectionProps}
			className={cn("flex flex-col gap-4", className)}
		>
			<Separator />
			<div className="flex max-w-2xl flex-col gap-1.5">
				<Heading
					id={titleId}
					className={cn("text-sm font-semibold", variant === "destructive" && "text-destructive")}
				>
					{title}
				</Heading>
				{description ? (
					<div className="text-sm leading-5 text-muted-foreground">{description}</div>
				) : null}
			</div>
			{children !== undefined && children !== null ? (
				<div className="min-w-0">{children}</div>
			) : null}
		</section>
	);
}
