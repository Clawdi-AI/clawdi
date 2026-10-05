import {
	cardActionClassName,
	cardClassName,
	cardContentClassName,
	cardDescriptionClassName,
	cardFooterClassName,
	cardHeaderClassName,
	cardTitleClassName,
} from "@clawdi/shared/ui";
import { cn } from "cn";
import { createContext, useContext } from "react";
import type { ViewProps } from "react-native";
import { Text, TextClassContext } from "./text";
import { AppView } from "./view";
import { resolveWebClasses } from "./web-classes";

type CardSize = "default" | "sm";
type ClassName = { className?: string };

const CardSizeContext = createContext<CardSize>("default");

/** Web sets `--card-spacing` to spacing(6), or spacing(4) for `size="sm"`. */
const spacing = {
	default: { root: "gap-6 py-6", inset: "px-6" },
	sm: { root: "gap-4 py-4", inset: "px-4" },
} as const;

const sizeState = (size: CardSize) => ({ "group-data-[size=sm]/card": size === "sm" });

/** apps/web/src/components/ui/card.tsx, rendered from the same classes. */
function Card({
	className,
	size = "default",
	...props
}: ViewProps & ClassName & { size?: CardSize }) {
	const classes = resolveWebClasses(cardClassName, { "data-[size=sm]": size === "sm" });
	return (
		<CardSizeContext.Provider value={size}>
			<TextClassContext.Provider value={classes.text}>
				<AppView className={cn(classes.view, spacing[size].root, className)} {...props} />
			</TextClassContext.Provider>
		</CardSizeContext.Provider>
	);
}

function CardHeader({ className, ...props }: ViewProps & ClassName) {
	const size = useContext(CardSizeContext);
	const classes = resolveWebClasses(cardHeaderClassName, sizeState(size));
	return <AppView className={cn(classes.view, spacing[size].inset, className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<typeof Text>) {
	const size = useContext(CardSizeContext);
	const classes = resolveWebClasses(cardTitleClassName, sizeState(size));
	return <Text accessibilityRole="header" className={cn(classes.text, className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<typeof Text>) {
	return (
		<Text className={cn(resolveWebClasses(cardDescriptionClassName).text, className)} {...props} />
	);
}

function CardAction({ className, ...props }: ViewProps & ClassName) {
	return (
		<AppView className={cn(resolveWebClasses(cardActionClassName).view, className)} {...props} />
	);
}

function CardContent({ className, ...props }: ViewProps & ClassName) {
	const size = useContext(CardSizeContext);
	const classes = resolveWebClasses(cardContentClassName);
	return <AppView className={cn(classes.view, spacing[size].inset, className)} {...props} />;
}

function CardFooter({ className, ...props }: ViewProps & ClassName) {
	const size = useContext(CardSizeContext);
	const classes = resolveWebClasses(cardFooterClassName);
	return <AppView className={cn(classes.view, spacing[size].inset, className)} {...props} />;
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
