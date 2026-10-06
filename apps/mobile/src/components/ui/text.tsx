import { cn } from "cn";
import { createContext, useContext } from "react";
import { Text as RNText, type TextProps } from "react-native";
import { withUniwind } from "uniwind";
import { resolveWebClasses } from "@/lib/web-classes";

const UniwindText = withUniwind(RNText);

/**
 * React Native text does not inherit styles from its parent View. Containers
 * that style their text on Web (Button, Badge, Card, ...) provide their text
 * classes here so nested `Text` matches the Web cascade.
 */
export const TextColorContext = createContext<string | undefined>(undefined);

export const TextClassContext = createContext<string | undefined>(undefined);

export type TextClassName = { className?: string };

export function Text({ className, style, ...props }: TextProps & TextClassName) {
	const inherited = useContext(TextClassContext);
	const color = useContext(TextColorContext);
	const merged = cn("text-base font-normal text-foreground", inherited, className);
	// Weight classes map to Geist families, so a mono family replaces them.
	const classes = merged.includes("font-mono") ? merged.replace(/\bfont-normal\b/, "") : merged;
	return (
		<TextClassContext.Provider value={resolveWebClasses(classes).text}>
			<UniwindText style={color ? [{ color }, style] : style} className={classes} {...props} />
		</TextClassContext.Provider>
	);
}
