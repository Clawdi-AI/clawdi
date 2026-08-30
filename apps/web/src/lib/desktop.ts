"use client";

import type { ClawdiDesktopShellBridge } from "@clawdi/shared/desktop";
import { useEffect, useState } from "react";

declare global {
	interface Window {
		clawdiDesktop?: ClawdiDesktopShellBridge;
	}
}

export function useDesktopBridge(): ClawdiDesktopShellBridge | null | undefined {
	const [bridge, setBridge] = useState<ClawdiDesktopShellBridge | null>();
	useEffect(() => {
		setBridge(window.clawdiDesktop ?? null);
	}, []);
	return bridge;
}
