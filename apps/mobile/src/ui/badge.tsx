import { badgeVariants } from "@clawdi/shared/ui";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ViewProps } from "react-native";
import { TextClassContext } from "./text";
import { AppView } from "./view";
import { resolveWebClasses } from "./web-classes";

/** apps/web/src/components/ui/badge.tsx, rendered from the same variants. */
export function Badge({
	className,
	variant,
	...props
}: ViewProps & VariantProps<typeof badgeVariants> & { className?: string }) {
	const classes = resolveWebClasses(cn(badgeVariants({ variant }), className));
	return (
		<TextClassContext.Provider value={classes.text}>
			<AppView className={classes.view} {...props} />
		</TextClassContext.Provider>
	);
}
