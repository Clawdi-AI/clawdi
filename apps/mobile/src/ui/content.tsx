import { cn } from "cn";
import { type ReactNode, useContext } from "react";
import { Text, TextClassContext } from "./text";
import { AppView } from "./view";

/** Preserve Web text inheritance without nesting native Views inside Text. */
export function Content({ children, className }: { children?: ReactNode; className?: string }) {
	const inherited = useContext(TextClassContext);
	return typeof children === "string" || typeof children === "number" ? (
		<Text className={className}>{children}</Text>
	) : (
		<TextClassContext.Provider value={cn(inherited, className)}>
			<AppView>{children}</AppView>
		</TextClassContext.Provider>
	);
}
