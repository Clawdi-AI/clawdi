import { cn } from "cn";
import { createContext, useContext } from "react";
import { Text as RNText, type TextProps } from "react-native";
import { withUniwind } from "uniwind";

const UniwindText = withUniwind(RNText);

/**
 * React Native text does not inherit styles from its parent View. Containers
 * that style their text on Web (Button, Badge, Card, ...) provide their text
 * classes here so nested `Text` matches the Web cascade.
 */
export const TextClassContext = createContext<string | undefined>(undefined);

export type TextClassName = { className?: string };

export function Text({ className, ...props }: TextProps & TextClassName) {
	const inherited = useContext(TextClassContext);
	const merged = cn("text-base font-normal text-foreground", inherited, className);
	// Weight classes map to Geist families, so a mono family replaces them.
	return (
		<UniwindText
			className={merged.includes("font-mono") ? merged.replace(/\bfont-normal\b/, "") : merged}
			{...props}
		/>
	);
}
