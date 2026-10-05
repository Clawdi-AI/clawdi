import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { PressableProps } from "react-native";
import { TextClassContext } from "./text";
import { AppPressable } from "./view";

/** Mirrors apps/web/src/components/ui/button.tsx; `active:` stands in for hover. */
const buttonVariants = cva(
	"shrink-0 flex-row items-center justify-center rounded-md border border-transparent disabled:opacity-50",
	{
		variants: {
			variant: {
				default: "bg-primary active:bg-primary/80",
				outline:
					"border-border bg-background shadow-xs active:bg-muted dark:border-input dark:bg-input/30",
				secondary: "bg-secondary active:bg-secondary/80",
				ghost: "active:bg-muted",
				destructive: "bg-destructive/10 active:bg-destructive/20 dark:bg-destructive/20",
				link: "",
			},
			size: {
				default: "h-9 gap-1.5 px-2.5",
				xs: "h-6 gap-1 rounded-md px-2",
				sm: "h-8 gap-1 rounded-md px-2.5",
				lg: "h-10 gap-1.5 px-2.5",
				icon: "size-9",
				"icon-xs": "size-6 rounded-md",
				"icon-sm": "size-8 rounded-md",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

const buttonTextVariants = cva("text-sm font-medium", {
	variants: {
		variant: {
			default: "text-primary-foreground",
			outline: "text-foreground",
			secondary: "text-secondary-foreground",
			ghost: "text-foreground",
			destructive: "text-destructive",
			link: "text-primary",
		},
		size: {
			default: "",
			xs: "text-xs",
			sm: "",
			lg: "",
			icon: "",
			"icon-xs": "text-xs",
			"icon-sm": "",
			"icon-lg": "",
		},
	},
	defaultVariants: { variant: "default", size: "default" },
});

type ButtonProps = PressableProps &
	VariantProps<typeof buttonVariants> & {
		className?: string;
		/** Extra text classes for nested `Text`/`Icon`, e.g. `text-muted-foreground`. */
		textClassName?: string;
	};

function Button({ className, textClassName, variant, size, ...props }: ButtonProps) {
	return (
		<TextClassContext.Provider value={cn(buttonTextVariants({ variant, size }), textClassName)}>
			<AppPressable
				accessibilityRole="button"
				className={cn(buttonVariants({ variant, size }), className)}
				{...props}
			/>
		</TextClassContext.Provider>
	);
}

export type { ButtonProps };
export { Button, buttonTextVariants, buttonVariants };
