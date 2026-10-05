import { inputClassName, labelClassName, textareaClassName } from "@clawdi/shared/ui";
import { cn } from "cn";
import { forwardRef } from "react";
import type { TextInput, TextInputProps } from "react-native";
import { useCSSVariable } from "uniwind";
import { Text } from "./text";
import { AppTextInput } from "./view";
import { resolveWebClasses } from "./web-classes";

type InputProps = TextInputProps & { className?: string };

/** apps/web/src/components/ui/input.tsx and textarea.tsx, from the same classes. */
export const Input = forwardRef<TextInput, InputProps>(function Input(
	{ className, style, ...props },
	ref,
) {
	const placeholder = useCSSVariable("--color-muted-foreground");
	const classes = resolveWebClasses(props.multiline ? textareaClassName : inputClassName);
	return (
		<AppTextInput
			ref={ref}
			style={[{ flexShrink: 0 }, style]}
			placeholderTextColor={typeof placeholder === "string" ? placeholder : undefined}
			textAlignVertical={props.multiline ? "top" : "center"}
			className={cn(classes.view, "font-normal text-foreground", classes.text, className)}
			{...props}
		/>
	);
});

/** apps/web/src/components/ui/label.tsx. */
export function Label({ className, ...props }: React.ComponentProps<typeof Text>) {
	return <Text className={cn(resolveWebClasses(labelClassName).text, className)} {...props} />;
}
