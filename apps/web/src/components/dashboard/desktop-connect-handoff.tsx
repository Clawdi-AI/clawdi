"use client";

import { DESKTOP_CONNECT_DEEP_LINK, DESKTOP_DOWNLOAD_URL } from "@clawdi/shared/desktop";
import { DESKTOP_HANDOFF_COPY } from "@clawdi/shared/view";
import { ExternalLink, Laptop } from "lucide-react";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";

/**
 * Hands Add agent off to Clawdi Desktop's Connect window. The browser asks
 * before it opens the app and does nothing when Desktop isn't installed, so
 * the download link and the manual steps below it stay visible; the setup
 * dialog detects a new agent either way.
 */
export function DesktopConnectHandoff() {
	return (
		<section
			aria-labelledby="desktop-connect-handoff-title"
			className="rounded-lg border bg-muted/30 p-4"
		>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
				<div className="flex min-w-0 flex-1 items-start gap-3">
					<IconChip size="sm" tint="bg-primary/10 text-primary">
						<Laptop />
					</IconChip>
					<div className="min-w-0">
						<p id="desktop-connect-handoff-title" className="text-sm font-medium">
							{DESKTOP_HANDOFF_COPY.title}
						</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{DESKTOP_HANDOFF_COPY.description}
						</p>
					</div>
				</div>
				<Button
					render={<a href={DESKTOP_CONNECT_DEEP_LINK} />}
					nativeButton={false}
					size="sm"
					className="w-full sm:w-auto"
				>
					{DESKTOP_HANDOFF_COPY.open}
				</Button>
			</div>
			<p className="mt-3 text-xs text-muted-foreground">
				{DESKTOP_HANDOFF_COPY.downloadPrompt}{" "}
				<a
					href={DESKTOP_DOWNLOAD_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
				>
					{DESKTOP_HANDOFF_COPY.download}
					<ExternalLink aria-hidden className="size-3" />
				</a>
			</p>
		</section>
	);
}
