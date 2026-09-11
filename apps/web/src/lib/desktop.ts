"use client";

import type { ClawdiDesktopShellBridge } from "@clawdi/shared/desktop";
import { useEffect, useState } from "react";
import { compatibleDesktopBridge, DesktopBridgeCompatibilityError } from "./desktop-bridge";

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
