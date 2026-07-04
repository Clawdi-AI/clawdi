"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAbsoluteTooltip } from "@/lib/utils";

export function TimeTooltip({
	value,
	children,
}: {
	value: string | null | undefined;
	children: React.ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent>{formatAbsoluteTooltip(value)}</TooltipContent>
		</Tooltip>
	);
}
