import { inputClassName, labelClassName, textareaClassName } from "@clawdi/shared/ui";
import { cn } from "cn";
import { forwardRef, useState } from "react";
import type { TextInputInstance, TextInputProps } from "react-native";
import { useCSSVariable } from "uniwind";
import { Text } from "@/components/ui/text";
import { AppTextInput, AppView } from "@/components/ui/view";
import { minHeightClasses, resolveWebClasses } from "@/lib/web-classes";

type InputProps = TextInputProps & { className?: string };

const PADDING = /^p[xytrbl]?-/;
const FOCUS = /^(dark:)?focus:/;

/**
 * apps/web/src/components/ui/input.tsx and textarea.tsx, from the same classes.
 *
 * The field chrome (border, background, radius, height) lives on a wrapping
 * view. Android resets an EditText's padding to its background drawable's
 * padding whenever React Native installs a new background, which happens when
 * a theme switch first gives the field a background color; the inner input
 * therefore keeps a constant transparent background and owns only the padding
 * and text styles.
 */
export const Input = forwardRef<TextInputInstance, InputProps>(function Input(
	{ className, onFocus, onBlur, ...props },
	ref,
) {
	const placeholder = useCSSVariable("--color-muted-foreground");
	const [focused, setFocused] = useState(false);
	const web = resolveWebClasses(props.multiline ? textareaClassName : inputClassName);
	const own = resolveWebClasses(className ?? "");
	const chrome: string[] = [];
	const padding: string[] = [];
	for (const token of `${web.view} ${own.view}`.split(/\s+/).filter(Boolean)) {
		if (PADDING.test(token)) padding.push(token);
		else if (!FOCUS.test(token)) chrome.push(token);
		else if (focused) chrome.push(token.replace(FOCUS, "$1"));
	}
	return (
		<AppView
			className={cn(
				"shrink-0",
				minHeightClasses(chrome.join(" ")),
				props.editable === false && "opacity-50",
			)}
		>
			<AppTextInput
				ref={ref}
				placeholderTextColor={typeof placeholder === "string" ? placeholder : undefined}
				textAlignVertical={props.multiline ? "top" : "center"}
				className={cn(
					"grow bg-transparent font-normal text-foreground",
					padding.join(" "),
					web.text,
					own.text,
				)}
				onFocus={(event) => {
					setFocused(true);
					onFocus?.(event);
				}}
				onBlur={(event) => {
					setFocused(false);
					onBlur?.(event);
				}}
				{...props}
			/>
		</AppView>
	);
});

/** apps/web/src/components/ui/label.tsx. */
export function Label({ className, ...props }: React.ComponentProps<typeof Text>) {
	return <Text className={cn(resolveWebClasses(labelClassName).text, className)} {...props} />;
}
