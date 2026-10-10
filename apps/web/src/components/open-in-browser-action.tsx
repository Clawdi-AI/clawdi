"use client";

import { ExternalLink } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { useDesktopShell } from "@/lib/desktop-shell";
import { cn } from "@/lib/utils";

/**
 * Inside Clawdi Desktop, stands in for an action that must run in the system
 * browser (payment details, auto-reload, plan changes). It opens the current
 * page there; renders nothing in a normal browser.
 */
export function OpenInBrowserAction({
	children,
	"aria-label": ariaLabel,
	align = "start",
	className,
}: {
	children: ReactNode;
	"aria-label"?: string;
	align?: "start" | "end";
	className?: string;
}) {
	const desktop = useDesktopShell();
	const noteId = useId();
	if (!desktop.inDesktop) return null;
	return (
		<div
			data-slot="open-in-browser-action"
			className={cn(
				"flex flex-col gap-1",
				align === "end" ? "items-end text-right" : "items-start",
				className,
			)}
		>
			<Button
				type="button"
				variant="outline"
				size="sm"
				aria-label={ariaLabel}
				aria-describedby={noteId}
				onClick={() => desktop.openInBrowser()}
			>
				{children}
				<ExternalLink data-icon="inline-end" aria-hidden />
			</Button>
			<p id={noteId} className="text-xs text-muted-foreground">
				Opens in your browser.
			</p>
		</div>
	);
}
