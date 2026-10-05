import { cn } from "cn";
import { createContext, useContext } from "react";
import type { ViewProps } from "react-native";
import { Text, TextClassContext } from "./text";
import { AppView } from "./view";

type CardSize = "default" | "sm";
type ClassName = { className?: string };

const CardSizeContext = createContext<CardSize>("default");
const padding = { default: "px-6", sm: "px-4" } as const;

/** Mirrors apps/web/src/components/ui/card.tsx. */
function Card({
	className,
	size = "default",
	...props
}: ViewProps & ClassName & { size?: CardSize }) {
	return (
		<CardSizeContext.Provider value={size}>
			<TextClassContext.Provider value="text-sm text-card-foreground">
				<AppView
					className={cn(
						"flex-col overflow-hidden rounded-xl border border-foreground/10 bg-card shadow-xs",
						size === "sm" ? "gap-4 py-4" : "gap-6 py-6",
						className,
					)}
					{...props}
				/>
			</TextClassContext.Provider>
		</CardSizeContext.Provider>
	);
}

function CardHeader({ className, ...props }: ViewProps & ClassName) {
	const size = useContext(CardSizeContext);
	return <AppView className={cn("gap-1", padding[size], className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<typeof Text>) {
	const size = useContext(CardSizeContext);
	return (
		<Text
			accessibilityRole="header"
			className={cn(size === "sm" ? "text-sm" : "text-base", "font-medium", className)}
			{...props}
		/>
	);
}

function CardDescription({ className, ...props }: React.ComponentProps<typeof Text>) {
	return <Text className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function CardAction({ className, ...props }: ViewProps & ClassName) {
	return <AppView className={cn("self-start", className)} {...props} />;
}

function CardContent({ className, ...props }: ViewProps & ClassName) {
	const size = useContext(CardSizeContext);
	return <AppView className={cn("flex-col gap-3", padding[size], className)} {...props} />;
}

function CardFooter({ className, ...props }: ViewProps & ClassName) {
	const size = useContext(CardSizeContext);
	return <AppView className={cn("flex-row items-center", padding[size], className)} {...props} />;
}

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
