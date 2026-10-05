import { settingsSectionClasses as styles } from "@clawdi/shared/ui";
import { useId } from "react";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type SettingsSectionProps = Omit<
	React.ComponentProps<"section">,
	"aria-labelledby" | "children" | "title"
> & {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	children?: React.ReactNode;
	variant?: "default" | "destructive";
	headingLevel?: 2 | 3;
};

/** Flat form/settings section; use SectionLabel for list-group captions and DashboardSection for bordered content containers. */
export function SettingsSection({
	title,
	description,
	actions,
	children,
	className,
	variant = "default",
	headingLevel = 2,
	...sectionProps
}: SettingsSectionProps) {
	const generatedTitleId = useId();
	const Heading = headingLevel === 3 ? "h3" : "h2";
	return (
		<section
			{...sectionProps}
			aria-labelledby={generatedTitleId}
			className={cn(styles.root, className)}
		>
			<Separator />
			<div className={styles.header}>
				<div className={styles.body}>
					<Heading
						id={generatedTitleId}
						className={cn(styles.title, variant === "destructive" && styles.destructive)}
					>
						{title}
					</Heading>
					{description ? <div className={styles.description}>{description}</div> : null}
				</div>
				{actions ? <div className={styles.actions}>{actions}</div> : null}
			</div>
			{children !== undefined && children !== null ? (
				<div className={styles.content}>{children}</div>
			) : null}
		</section>
	);
}
