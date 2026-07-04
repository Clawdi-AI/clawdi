"use client";

import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAbsoluteTooltip } from "@/lib/utils";

export function TimeTooltip({
	value,
	children,
}: {
	value: string | null | undefined;
	children: ReactElement;
}) {
	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<TooltipContent>{formatAbsoluteTooltip(value)}</TooltipContent>
		</Tooltip>
	);
}
