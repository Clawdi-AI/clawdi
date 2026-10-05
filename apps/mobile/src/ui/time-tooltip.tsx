import type { ReactElement } from "react";
/** Preserve the caller's relative-time text; phones have no hover tooltip. */
export function TimeTooltip({
	children,
}: {
	value: string | null | undefined;
	children: ReactElement;
}) {
	return children;
}
