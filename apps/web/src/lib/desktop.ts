"use client";

import type { ClawdiDesktopShellBridge } from "@clawdi/shared/desktop";
import { useEffect, useState } from "react";
import { compatibleDesktopBridge, DesktopBridgeCompatibilityError } from "./desktop-bridge";

// TODO (2026-10-08): Remove after 2026-11-08; retained for Desktop beta.1–7.
declare global {
	interface Window {
		clawdiDesktop?: ClawdiDesktopShellBridge;
	}
}

export function useDesktopBridge(): ClawdiDesktopShellBridge | null | undefined {
	const [bridge, setBridge] = useState<ClawdiDesktopShellBridge | null>();
	useEffect(() => {
		setBridge(compatibleDesktopBridge(window.clawdiDesktop));
	}, []);
	if (bridge === null && typeof window !== "undefined" && window.clawdiDesktop) {
		throw new DesktopBridgeCompatibilityError();
	}
	return bridge;
}
