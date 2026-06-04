"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/* Floating bulk-action bar for curation flows (select skills → send to a
 * Project; select keys → move to a vault). Appears only while something
 * is selected, so it never competes with the page's primary actions. */

export function BulkActionBar({
	count,
	noun,
	onClear,
	children,
}: {
	count: number;
	/** Singular object name, e.g. "skill" / "key". */
	noun: string;
	onClear: () => void;
	children: React.ReactNode;
}) {
	if (count === 0) return null;
	return (
		<div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
			<div
				role="toolbar"
				aria-label="Bulk actions"
				className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-lg"
			>
				<span className="px-1 text-sm font-medium tabular-nums">
					{count} {noun}
					{count === 1 ? "" : "s"}
				</span>
				{children}
				<Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear selection">
					<X className="size-3.5" />
				</Button>
			</div>
		</div>
	);
}
