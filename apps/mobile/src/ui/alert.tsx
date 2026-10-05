import { cn } from "cn";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Icon } from "./icon";
import { Text, TextClassContext } from "./text";
import { AppView } from "./view";

/** Mirrors apps/web/src/components/ui/alert.tsx (icon column + title/description). */
export function Alert({
	variant = "default",
	icon,
	title,
	children,
	className,
}: {
	variant?: "default" | "destructive";
	icon?: LucideIcon;
	title?: ReactNode;
	children?: ReactNode;
	className?: string;
}) {
	const tone = variant === "destructive" ? "text-destructive" : "text-card-foreground";
	return (
		<TextClassContext.Provider value={cn("text-sm", tone)}>
			<AppView
				accessibilityRole="alert"
				className={cn(
					"w-full flex-row gap-2.5 rounded-lg border border-border bg-card px-4 py-3",
					className,
				)}
			>
				{icon ? (
					<AppView className="pt-0.5">
						<Icon as={icon} className={tone} />
					</AppView>
				) : null}
				<AppView className="min-w-0 flex-1 gap-0.5">
					{title ? <Text className="font-medium">{title}</Text> : null}
					{children ? (
						<TextClassContext.Provider
							value={cn(
								"text-sm",
								variant === "destructive" ? "text-destructive/90" : "text-muted-foreground",
							)}
						>
							{typeof children === "string" ? <Text>{children}</Text> : children}
						</TextClassContext.Provider>
					) : null}
				</AppView>
			</AppView>
		</TextClassContext.Provider>
	);
}
