import {
	emptyClassName,
	emptyContentClassName,
	emptyDescriptionClassName,
	emptyHeaderClassName,
	emptyMediaVariants,
	emptyStateClasses as styles,
} from "@clawdi/shared/ui";
import { cn } from "cn";
import { Inbox, type LucideIcon } from "lucide-react-native";
import { isValidElement, type ReactNode } from "react";
import { WebContent, WebIcon, WebView } from "@/components/ui/web-layout";

type EmptyStateVariant = "page" | "inset";
export function EmptyState({
	icon = Inbox,
	title,
	description,
	action,
	variant = "page",
	className,
}: {
	icon?: LucideIcon | ReactNode;
	title?: string;
	description?: ReactNode;
	action?: ReactNode;
	variant?: EmptyStateVariant;
	className?: string;
}) {
	const mark = !icon ? null : typeof icon === "string" ||
		typeof icon === "number" ||
		isValidElement(icon) ? (
		<WebContent recipe={styles.icon}>{icon}</WebContent>
	) : (
		<WebIcon as={icon as LucideIcon} recipe={styles.icon} />
	);
	return (
		<WebView
			recipe={cn(emptyClassName, variant === "page" ? styles.page : styles.inset)}
			className={className}
		>
			<WebView recipe={cn(emptyHeaderClassName, variant === "inset" && styles.insetHeader)}>
				{variant === "page" && mark ? (
					<WebView recipe={emptyMediaVariants({ variant: "icon" })}>{mark}</WebView>
				) : null}
				{title ? <WebContent recipe={styles.title}>{title}</WebContent> : null}
				{description ? (
					<WebContent recipe={emptyDescriptionClassName}>{description}</WebContent>
				) : null}
			</WebView>
			{action ? <WebView recipe={emptyContentClassName}>{action}</WebView> : null}
		</WebView>
	);
}
