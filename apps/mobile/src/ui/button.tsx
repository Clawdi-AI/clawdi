import { buttonVariants } from "@clawdi/shared/ui";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { useContext } from "react";
import type { PressableProps } from "react-native";
import { TextClassContext } from "./text";
import { TouchTargetContext } from "./touch-target";
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
	const touchTarget = useContext(TouchTargetContext);
	const inherited = useContext(TextClassContext);
	const classes = resolveWebClasses(buttonVariants({ variant, size }));
	// Like DOM, text classes on the container (e.g. `text-muted-foreground`) reach its text.
	const own = resolveWebClasses(className ?? "");
	return (
		<TextClassContext.Provider value={cn(inherited, classes.text, own.text, textClassName)}>
			<AppPressable
				accessibilityRole="button"
				className={cn(
					classes.view,
					touchTarget.button,
					(size?.startsWith("icon") || props.accessibilityLabel) && touchTarget.icon,
					own.view,
				)}
				{...props}
			/>
		</TextClassContext.Provider>
	);
}

export type { ButtonProps };
export { Button };
