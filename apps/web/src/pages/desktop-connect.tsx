"use client";

import { desktopHandoffClasses } from "@clawdi/shared/ui";
import {
	DESKTOP_CONNECT_DEEP_LINK,
	DESKTOP_HANDOFF_COPY,
	INSTALLATION_DOCS_URL,
} from "@clawdi/shared/view";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef } from "react";
import { DesktopDownloadPrompt } from "@/components/dashboard/desktop-connect-handoff";
import { Button } from "@/components/ui/button";

/**
 * Launch page opened in its own tab by Add agent. It opens Clawdi Desktop's
 * Connect window once and keeps the retry, download and manual fallbacks
 * visible, because a browser can't report whether the app opened.
 */
export function DesktopConnectPage() {
	// StrictMode replays effects in development; the browser should ask once.
	const launched = useRef(false);
	useEffect(() => {
		if (launched.current) return;
		launched.current = true;
		window.location.assign(DESKTOP_CONNECT_DEEP_LINK);
	}, []);

	return (
		<main className={desktopHandoffClasses.launchPage}>
			<div className={desktopHandoffClasses.launchCard}>
				<h1 className={desktopHandoffClasses.launchTitle}>{DESKTOP_HANDOFF_COPY.launchTitle}</h1>
				<p className={desktopHandoffClasses.launchDescription}>
					{DESKTOP_HANDOFF_COPY.launchDescription}
				</p>
				<Button render={<a href={DESKTOP_CONNECT_DEEP_LINK} />} nativeButton={false}>
					{DESKTOP_HANDOFF_COPY.open}
				</Button>
				<div className={desktopHandoffClasses.launchFallbacks}>
					<p>
						<DesktopDownloadPrompt />
					</p>
					<p>
						{DESKTOP_HANDOFF_COPY.launchManualPrompt}{" "}
						<a
							href={INSTALLATION_DOCS_URL}
							target="_blank"
							rel="noopener noreferrer"
							className={desktopHandoffClasses.externalLink}
						>
							{DESKTOP_HANDOFF_COPY.launchManual}
							<ExternalLink aria-hidden className={desktopHandoffClasses.externalIcon} />
						</a>
					</p>
					<p>{DESKTOP_HANDOFF_COPY.launchManualHint}</p>
				</div>
			</div>
		</main>
	);
}
