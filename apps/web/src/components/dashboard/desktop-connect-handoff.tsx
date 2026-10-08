"use client";

import { desktopHandoffClasses } from "@clawdi/shared/ui";
import {
	DESKTOP_CONNECT_LAUNCH_PATH,
	DESKTOP_DOWNLOAD_URL,
	DESKTOP_HANDOFF_COPY,
} from "@clawdi/shared/view";
import { ExternalLink, Laptop } from "lucide-react";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";

/**
 * Hands Add agent off to Clawdi Desktop's Connect window. The deep link opens
 * from the launch page in a new tab, so a browser that can't handle it only
 * affects that tab; this dialog keeps its manual steps and new-agent watcher.
 */
export function DesktopConnectHandoff() {
	return (
		<section aria-labelledby="desktop-connect-handoff-title" className={desktopHandoffClasses.root}>
			<div className={desktopHandoffClasses.row}>
				<div className={desktopHandoffClasses.summary}>
					<IconChip size="sm" tint={desktopHandoffClasses.iconTint}>
						<Laptop />
					</IconChip>
					<div className={desktopHandoffClasses.body}>
						<p id="desktop-connect-handoff-title" className={desktopHandoffClasses.title}>
							{DESKTOP_HANDOFF_COPY.title}
						</p>
						<p className={desktopHandoffClasses.description}>{DESKTOP_HANDOFF_COPY.description}</p>
					</div>
				</div>
				<Button
					render={<a href={DESKTOP_CONNECT_LAUNCH_PATH} target="_blank" rel="noopener" />}
					nativeButton={false}
					size="sm"
					className={desktopHandoffClasses.openAction}
				>
					{DESKTOP_HANDOFF_COPY.open}
				</Button>
			</div>
			<p className={desktopHandoffClasses.fallback}>
				<DesktopDownloadPrompt />
			</p>
		</section>
	);
}

/** "Don't have it? Download Clawdi Desktop", shared by the dialog and the launch page. */
export function DesktopDownloadPrompt() {
	return (
		<>
			{DESKTOP_HANDOFF_COPY.downloadPrompt}{" "}
			<a
				href={DESKTOP_DOWNLOAD_URL}
				target="_blank"
				rel="noopener noreferrer"
				className={desktopHandoffClasses.externalLink}
			>
				{DESKTOP_HANDOFF_COPY.download}
				<ExternalLink aria-hidden className={desktopHandoffClasses.externalIcon} />
			</a>
		</>
	);
}
