import { statusBadgeVariants, statusDotVariants } from "@clawdi/shared/ui";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ViewProps } from "react-native";
import { TextClassContext } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { resolveWebClasses } from "@/lib/web-classes";

type StatusTone = NonNullable<VariantProps<typeof statusBadgeVariants>["status"]>;

/** apps/web/src/components/ui/status-badge.tsx, rendered from the same variants. */
function StatusBadge({
	className,
	status = "neutral",
	withDot = false,
	children,
	...props
}: ViewProps & { className?: string; status?: StatusTone; withDot?: boolean }) {
	const classes = resolveWebClasses(statusBadgeVariants({ status }));
	const own = resolveWebClasses(className ?? "");
	return (
		<TextClassContext.Provider value={cn(classes.text, own.text)}>
			<AppView className={cn(classes.view, own.view)} {...props}>
				{withDot ? <StatusDot status={status} /> : null}
				{children}
			</AppView>
		</TextClassContext.Provider>
	);
}

/* Standalone status dot — for lists where a chip is too loud. */
function StatusDot({ className, status = "neutral" }: { className?: string; status?: StatusTone }) {
	return (
		<AppView
			accessibilityElementsHidden
			importantForAccessibility="no"
			className={cn(resolveWebClasses(statusDotVariants({ status })).view, className)}
		/>
	);
}


export type { StatusTone };
export { StatusBadge, StatusDot };
