"use client";

import type { ClawdiDashboardBridge } from "@clawdi/shared/desktop";
import { useEffect, useState } from "react";
import { compatibleDesktopBridge, DesktopBridgeCompatibilityError } from "./desktop-bridge";

declare global {
	interface Window {
		clawdiDesktop?: ClawdiDashboardBridge;
	}
}

export function useDesktopBridge(): ClawdiDashboardBridge | null | undefined {
	const [bridge, setBridge] = useState<ClawdiDashboardBridge | null>();
	useEffect(() => {
		setBridge(compatibleDesktopBridge(window.clawdiDesktop));
	}, []);
	if (bridge === null && typeof window !== "undefined" && window.clawdiDesktop) {
		throw new DesktopBridgeCompatibilityError();
	}
	return bridge;
}
