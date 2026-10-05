import { alertDescriptionClassName, alertTitleClassName, alertVariants } from "@clawdi/shared/ui";
import { cn } from "cn";
import type { LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Icon } from "./icon";
import { Text, TextClassContext } from "./text";
import { AppView } from "./view";
import { resolveWebClasses } from "./web-classes";

/**
 * apps/web/src/components/ui/alert.tsx from the same classes. Web lays the
 * optional icon out as a grid column; here it is a row.
 */
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
	const root = resolveWebClasses(alertVariants({ variant }));
	const description = resolveWebClasses(alertDescriptionClassName).text;
	return (
		<TextClassContext.Provider value={root.text}>
			<AppView accessibilityRole="alert" className={cn(root.view, "flex-row gap-2.5", className)}>
				{icon ? (
					<AppView className="pt-0.5">
						<Icon as={icon} />
					</AppView>
				) : null}
				<AppView className="min-w-0 flex-1 gap-0.5">
					{title ? (
						<Text className={resolveWebClasses(alertTitleClassName).text}>{title}</Text>
					) : null}
					{children ? (
						<TextClassContext.Provider
							value={cn(description, variant === "destructive" && "text-destructive/90")}
						>
							{typeof children === "string" ? <Text>{children}</Text> : children}
						</TextClassContext.Provider>
					) : null}
				</AppView>
			</AppView>
		</TextClassContext.Provider>
	);
}
