import { cn } from "cn";
import { Inbox, type LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Icon } from "./icon";
import { Text } from "./text";
import { AppView } from "./view";

/**
 * Mirrors apps/web/src/components/empty-state.tsx.
 * Page: flat centered panel with an icon tile. Inset: compact muted tile.
 */
export function EmptyState({
	icon = Inbox,
	title,
	description,
	action,
	variant = "page",
	className,
}: {
	icon?: LucideIcon;
	title?: string;
	description?: ReactNode;
	action?: ReactNode;
	variant?: "page" | "inset";
	className?: string;
}) {
	return (
		<AppView
			className={cn(
				"w-full min-w-0 items-center justify-center rounded-lg",
				variant === "page"
					? "min-h-80 flex-1 gap-4"
					: "gap-3 border border-border bg-muted/30 px-4 py-6",
				className,
			)}
		>
			<AppView className={cn("max-w-sm items-center", variant === "inset" ? "gap-1" : "gap-2")}>
				{variant === "page" ? (
					<AppView className="mb-2 size-10 items-center justify-center rounded-lg bg-muted">
						<Icon as={icon} className="size-5 text-foreground" />
					</AppView>
				) : null}
				{title ? <Text className="text-center text-sm font-medium">{title}</Text> : null}
				{typeof description === "string" ? (
					<Text className="text-center text-sm leading-relaxed text-muted-foreground">
						{description}
					</Text>
				) : (
					description
				)}
			</AppView>
			{action ? <AppView className="w-full max-w-sm items-center gap-4">{action}</AppView> : null}
		</AppView>
	);
}
