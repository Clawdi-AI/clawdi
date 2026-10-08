"use client";

import { createFileRoute } from "@tanstack/react-router";
import { DesktopWindowDragRegion } from "@/components/desktop-window-drag-region";
import { buttonVariants } from "@/components/ui/button";
import { useDesktopBridge } from "@/lib/desktop";
import { routeHeadTitle } from "@/lib/document-title";

// TODO (2026-10-08): Remove after 2026-11-08; retained for Desktop beta.1–7.
export const Route = createFileRoute("/desktop-auth")({
	head: () => routeHeadTitle("Open Clawdi in your browser"),
	component: DesktopAuthPage,
});

export function DesktopAuthPage() {
	const desktopBridge = useDesktopBridge();
	return (
		<main className="flex min-h-dvh items-center justify-center bg-background p-6">
			{desktopBridge ? <DesktopWindowDragRegion /> : null}
			<div className="flex max-w-sm flex-col items-center gap-4 text-center">
				<h1 className="text-lg font-semibold">Open Clawdi in your browser</h1>
				<p className="text-sm text-muted-foreground">
					Update Clawdi Desktop to continue. Sign in to the dashboard in your browser.
				</p>
				{/* Released Desktop opens new-window links in the system browser. */}
				<a
					className={buttonVariants()}
					href="https://cloud.clawdi.ai"
					target="_blank"
					rel="noopener noreferrer"
				>
					Open Clawdi in your browser
				</a>
			</div>
		</main>
	);
}
