import { DESKTOP_DEEP_LINK_SCHEME, type DesktopConnectView } from "@clawdi/shared/desktop";

/**
 * Maps a `clawdi-desktop://` URL to the Connect view it opens. Deep links are
 * untrusted input from any web page, so only the exact parameterless
 * `clawdi-desktop://connect` link is accepted; it can only focus a window.
 */
export function connectViewFromDeepLink(value: string): DesktopConnectView | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	const accepted =
		url.protocol === `${DESKTOP_DEEP_LINK_SCHEME}:` &&
		url.host === "connect" &&
		!url.username &&
		!url.password &&
		(url.pathname === "" || url.pathname === "/") &&
		!url.search &&
		!url.hash;
	return accepted ? "connect" : null;
}

/**
 * Finds a deep link in a launch command line (Windows and Linux cold start or
 * `second-instance`). The OS appends the URL as its own argument; anything
 * else in argv is ignored.
 * https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app
 */
export function connectViewFromArgv(argv: readonly string[]): DesktopConnectView | null {
	const prefix = `${DESKTOP_DEEP_LINK_SCHEME}:`;
	const link = [...argv].reverse().find((arg) => arg.toLowerCase().startsWith(prefix));
	return link === undefined ? null : connectViewFromDeepLink(link);
}
