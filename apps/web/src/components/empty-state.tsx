import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
	icon?: LucideIcon;
	title?: string;
	description?: ReactNode;
	action?: ReactNode;
	/** When set, wraps in a rounded muted tile. Default is flat — just centered text. */
	bordered?: boolean;
	/**
	 * When true (default), reserve vertical space so the hint sits mid-pane
	 * instead of floating near the top. Set false inside cards / sub-regions
	 * where surrounding chrome already sets the visual weight.
	 */
	fillHeight?: boolean;
	className?: string;
}

/**
 * Centered empty-state message. Thin wrapper around shadcn's `<Empty>`
 * primitives so call sites get a single prop-driven API while everything
 * styling / aria comes from upstream.
 *
 * If a page needs unusual composition (multiple actions, custom media,
 * nested sections), import the `<Empty>` parts from `@/components/ui/empty`
 * directly instead of expanding this component's props.
 */
export function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	bordered = false,
	fillHeight = true,
	className,
}: EmptyStateProps) {
	return (
		<Empty
			className={cn(
				// shadcn's default already includes `rounded-lg border-dashed p-6
				// md:p-12`. The flat variant (default) strips the border + padding
				// because most of our usages live inside existing card chrome.
				bordered ? "border bg-muted/20" : "border-none p-0 md:p-0",
				fillHeight ? "min-h-[320px]" : "py-8 md:py-8",
				className,
			)}
		>
			<EmptyHeader>
				{Icon ? (
					<EmptyMedia>
						<Icon className="size-8 text-muted-foreground/60" aria-hidden />
					</EmptyMedia>
				) : null}
				{title ? <EmptyTitle className="text-sm">{title}</EmptyTitle> : null}
				{description ? <EmptyDescription>{description}</EmptyDescription> : null}
			</EmptyHeader>
			{action ? <EmptyContent>{action}</EmptyContent> : null}
		</Empty>
	);
}
