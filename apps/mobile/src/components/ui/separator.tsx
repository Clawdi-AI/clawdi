import { separatorClassName } from "@clawdi/shared/ui";
import { cn } from "cn";
import { AppView } from "@/components/ui/view";
import { resolveWebClasses } from "@/lib/web-classes";

/** apps/web/src/components/ui/separator.tsx, rendered from the same classes. */
export function Separator({
	className,
	orientation = "horizontal",
}: {
	className?: string;
	orientation?: "horizontal" | "vertical";
}) {
	const classes = resolveWebClasses(separatorClassName, {
		"data-horizontal": orientation === "horizontal",
		"data-vertical": orientation === "vertical",
	});
	return (
		<AppView
			accessibilityElementsHidden
			importantForAccessibility="no"
			className={cn(classes.view, className)}
		/>
	);
}
