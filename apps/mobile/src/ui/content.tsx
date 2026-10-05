import { cn } from "cn";
import { type ReactNode, useContext } from "react";
import { Text, TextClassContext } from "./text";

/**
 * Preserve Web text inheritance without nesting native Views inside Text. Like
 * DOM children, mixed children join the parent's flex layout directly.
 */
export function Content({ children, className }: { children?: ReactNode; className?: string }) {
	const inherited = useContext(TextClassContext);
	return typeof children === "string" || typeof children === "number" ? (
		<Text className={className}>{children}</Text>
	) : (
		<TextClassContext.Provider value={cn(inherited, className)}>
			{children}
		</TextClassContext.Provider>
	);
}
