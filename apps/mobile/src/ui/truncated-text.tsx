import { cn } from "cn";
import type { ComponentProps } from "react";
import { Text } from "./text";
/** Full text stays available to accessibility; native single-line ellipsis replaces hover. */
export function TruncatedText({
	title,
	className,
	...props
}: ComponentProps<typeof Text> & { title?: string }) {
	return (
		<Text
			numberOfLines={1}
			ellipsizeMode="tail"
			accessibilityLabel={title}
			className={cn("min-w-0", className)}
			{...props}
		/>
	);
}
