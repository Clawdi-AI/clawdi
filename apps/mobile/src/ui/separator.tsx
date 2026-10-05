import { cn } from "cn";
import { AppView } from "./view";

/** Mirrors apps/web/src/components/ui/separator.tsx. */
export function Separator({
	className,
	orientation = "horizontal",
}: {
	className?: string;
	orientation?: "horizontal" | "vertical";
}) {
	return (
		<AppView
			accessibilityElementsHidden
			importantForAccessibility="no"
			className={cn(
				"shrink-0 bg-border",
				orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch",
				className,
			)}
		/>
	);
}
