import { buttonVariants } from "@clawdi/shared/ui";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import type { PressableProps } from "react-native";
import { TextClassContext } from "./text";
import { AppPressable } from "./view";
import { resolveWebClasses } from "./web-classes";

type ButtonProps = PressableProps &
	VariantProps<typeof buttonVariants> & {
		className?: string;
		/** Extra text classes for nested `Text`/`Icon`, e.g. `text-muted-foreground`. */
		textClassName?: string;
	};

/** apps/web/src/components/ui/button.tsx, rendered from the same variants. */
function Button({ className, textClassName, variant, size, ...props }: ButtonProps) {
	const classes = resolveWebClasses(buttonVariants({ variant, size }));
	return (
		<TextClassContext.Provider value={cn(classes.text, textClassName)}>
			<AppPressable accessibilityRole="button" className={cn(classes.view, className)} {...props} />
		</TextClassContext.Provider>
	);
}

export type { ButtonProps };
export { Button };
