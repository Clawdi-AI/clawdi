import { Inbox, type LucideIcon } from "lucide-react";
import { isValidElement, type ReactNode } from "react";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

export type EmptyStateVariant = "page" | "inset";

interface EmptyStateProps {
	icon?: LucideIcon | ReactNode;
	title?: string;
	description?: ReactNode;
	action?: ReactNode;
	variant?: EmptyStateVariant;
	className?: string;
}

/**
 * Canonical empty placeholder.
 * Page: flat centered panel with generous height and an icon tile.
 * Inset: compact muted tile inside existing page/card chrome.
 */
export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	variant = "page",
	className,
}: EmptyStateProps) {
	const icon = variant === "page" ? renderEmptyIcon(Icon === undefined ? Inbox : Icon) : null;
	return (
		<Empty
			className={cn(
				variant === "page"
					? "min-h-[320px] border-none bg-transparent p-0 md:p-0"
					: "min-h-0 flex-none gap-3 border border-solid bg-muted/30 px-4 py-6 md:p-6",
				className,
			)}
		>
			<EmptyHeader className={cn(variant === "inset" && "gap-1")}>
				{icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
				{title ? (
					<EmptyTitle className="text-sm font-medium tracking-normal">{title}</EmptyTitle>
				) : null}
				{description ? <EmptyDescription>{description}</EmptyDescription> : null}
			</EmptyHeader>
			{action ? <EmptyContent>{action}</EmptyContent> : null}
		</Empty>
	);
}

function renderEmptyIcon(icon: EmptyStateProps["icon"]) {
	if (!icon) return null;
	if (isValidElement(icon) || typeof icon === "string" || typeof icon === "number") return icon;
	const Icon = icon as LucideIcon;
	return <Icon className="size-5" aria-hidden />;
}
