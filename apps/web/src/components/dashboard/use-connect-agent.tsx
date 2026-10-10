"use client";

import { type ClawdiDesktopBridge, isClawdiDesktopBridge } from "@clawdi/shared/desktop";
import { useCallback, useState, useSyncExternalStore } from "react";
import { AddAgentDialog } from "@/components/dashboard/add-agent-dialog";

let cachedBridge: ClawdiDesktopBridge | null | undefined;

function desktopBridge(): ClawdiDesktopBridge | null {
	// Desktop's preload exposes the bridge before page scripts run; it never changes.
	if (cachedBridge === undefined) {
		const candidate: unknown = Reflect.get(window, "clawdiDesktop");
		cachedBridge = isClawdiDesktopBridge(candidate) ? candidate : null;
	}
	return cachedBridge;
}

const subscribe = () => () => undefined;

/**
 * The one way to start connecting an agent. Inside Clawdi Desktop, `connect`
 * opens its native Connect window; in a browser it opens the Add agent dialog,
 * which callers render as `dialog`. SSR and hydration render the browser path.
 */
export function useConnectAgent() {
	const bridge = useSyncExternalStore(subscribe, desktopBridge, () => null);
	const [open, setOpen] = useState(false);
	const connect = useCallback(() => {
		if (bridge) bridge.openConnector();
		else setOpen(true);
	}, [bridge]);
	const dialog = <AddAgentDialog open={open} onClose={() => setOpen(false)} />;
	return { connect, dialog };
}
