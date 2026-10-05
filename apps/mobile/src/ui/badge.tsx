import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { ViewProps } from "react-native";
import { TextClassContext } from "./text";
import { AppView } from "./view";

/** Mirrors apps/web/src/components/ui/badge.tsx. */
const badgeVariants = cva(
	"h-5 shrink-0 flex-row items-center justify-center gap-1 self-start overflow-hidden rounded-full border border-transparent px-2 py-0.5",
	{
		variants: {
			variant: {
				default: "bg-primary",
				secondary: "bg-secondary",
				destructive: "bg-destructive/10 dark:bg-destructive/20",
				outline: "border-border",
				ghost: "",
				link: "",
			},
		},
		defaultVariants: { variant: "default" },
	},
);

const badgeTextVariants = cva("text-xs font-medium", {
	variants: {
		variant: {
			default: "text-primary-foreground",
			secondary: "text-secondary-foreground",
			destructive: "text-destructive",
			outline: "text-foreground",
			ghost: "text-foreground",
			link: "text-primary",
		},
	},
	defaultVariants: { variant: "default" },
});

function Badge({
	className,
	variant,
	...props
}: ViewProps & VariantProps<typeof badgeVariants> & { className?: string }) {
	return (
		<TextClassContext.Provider value={badgeTextVariants({ variant })}>
			<AppView className={cn(badgeVariants({ variant }), className)} {...props} />
		</TextClassContext.Provider>
	);
}

export { Badge, badgeVariants };
