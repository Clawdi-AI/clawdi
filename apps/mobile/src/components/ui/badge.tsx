import { badgeVariants } from "@clawdi/shared/ui";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ViewProps } from "react-native";
import { TextClassContext } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { resolveWebClasses } from "@/lib/web-classes";

/** apps/web/src/components/ui/badge.tsx, rendered from the same variants. */
export function Badge({
	className,
	variant,
	...props
}: ViewProps & VariantProps<typeof badgeVariants> & { className?: string }) {
	const classes = resolveWebClasses(badgeVariants({ variant }));
	// Like DOM, text classes on the container (e.g. category colors) reach its text.
	const own = resolveWebClasses(className ?? "");
	return (
		<TextClassContext.Provider value={cn(classes.text, own.text)}>
			<AppView className={cn(classes.view, own.view)} {...props} />
		</TextClassContext.Provider>
	);
}
