"use client";

import type { ClawdiDesktopBridge } from "@clawdi/shared/desktop";
import { useEffect, useState } from "react";

declare global {
	interface Window {
		clawdiDesktop?: ClawdiDesktopBridge;
	}
}

export function useDesktopBridge(): ClawdiDesktopBridge | null | undefined {
	const [bridge, setBridge] = useState<ClawdiDesktopBridge | null>();
	useEffect(() => {
		setBridge(window.clawdiDesktop ?? null);
	}, []);
	return bridge;
}
