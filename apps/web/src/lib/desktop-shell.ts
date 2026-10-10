import { useMemo, useSyncExternalStore } from "react";

/**
 * The part of Clawdi Desktop's preload bridge the dashboard uses.
 * TODO: import `ClawdiDesktopBridge` from `@clawdi/shared/desktop` once the
 * Desktop shell change that defines it lands; keep this the only copy.
 */
export interface DesktopShellBridge {
	readonly version: 1;
	openConnector(): void;
	/** Opens an HTTPS page on the Clawdi web origin in the system browser. */
	openInBrowser(url: string): void;
}

export type DesktopShell =
	| { inDesktop: false }
	| {
			inDesktop: true;
			openConnector: () => void;
			/** Opens `url`, resolved against the current page, in the system browser. */
			openInBrowser: (url?: string) => void;
	  };

const NOT_IN_DESKTOP: DesktopShell = { inDesktop: false };

/** Capability detection: Desktop's preload exposes a versioned bridge; browsers have none. */
export function readDesktopShellBridge(target: object | undefined): DesktopShellBridge | null {
	if (!target) return null;
	const bridge: unknown = Reflect.get(target, "clawdiDesktop");
	if (typeof bridge !== "object" || bridge === null) return null;
	if (Reflect.get(bridge, "version") !== 1) return null;
	const openConnector: unknown = Reflect.get(bridge, "openConnector");
	const openInBrowser: unknown = Reflect.get(bridge, "openInBrowser");
	if (typeof openConnector !== "function" || typeof openInBrowser !== "function") return null;
	return {
		version: 1,
		openConnector: () => openConnector.call(bridge),
		openInBrowser: (url) => openInBrowser.call(bridge, url),
	};
}

let cachedBridge: DesktopShellBridge | null | undefined;

function clientBridge(): DesktopShellBridge | null {
	// The preload runs before page scripts, so the bridge never changes afterwards.
	if (cachedBridge === undefined) cachedBridge = readDesktopShellBridge(window);
	return cachedBridge;
}

const subscribe = () => () => undefined;

/**
 * Whether the dashboard runs inside Clawdi Desktop's window, and the native
 * actions it offers there. SSR and the hydration render report a browser.
 */
export function useDesktopShell(): DesktopShell {
	const bridge = useSyncExternalStore(subscribe, clientBridge, () => null);
	return useMemo(() => {
		if (!bridge) return NOT_IN_DESKTOP;
		return {
			inDesktop: true,
			openConnector: () => bridge.openConnector(),
			openInBrowser: (url = window.location.href) =>
				bridge.openInBrowser(new URL(url, window.location.href).toString()),
		};
	}, [bridge]);
}
