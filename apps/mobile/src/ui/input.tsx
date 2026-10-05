import { cn } from "cn";
import { forwardRef } from "react";
import type { TextInput, TextInputProps } from "react-native";
import { useCSSVariable } from "uniwind";
import { Text } from "./text";
import { AppTextInput } from "./view";

type InputProps = TextInputProps & { className?: string };

/** Mirrors apps/web/src/components/ui/input.tsx. */
export const Input = forwardRef<TextInput, InputProps>(function Input(
	{ className, ...props },
	ref,
) {
	const placeholder = useCSSVariable("--color-muted-foreground");
	return (
		<AppTextInput
			ref={ref}
			placeholderTextColor={typeof placeholder === "string" ? placeholder : undefined}
			className={cn(
				"h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-2.5 py-1 font-normal text-base text-foreground shadow-xs focus:border-ring disabled:opacity-50 dark:bg-input/30",
				props.multiline && "h-auto min-h-16 py-2",
				className,
			)}
			{...props}
		/>
	);
});

/** Mirrors apps/web/src/components/ui/label.tsx. */
export function Label({ className, ...props }: React.ComponentProps<typeof Text>) {
	return <Text className={cn("text-sm leading-none font-medium", className)} {...props} />;
}
