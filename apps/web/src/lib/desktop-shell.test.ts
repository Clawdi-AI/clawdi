import { expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readDesktopShellBridge, useDesktopShell } from "@/lib/desktop-shell";

test("detects only a version 1 bridge that offers both actions", () => {
	const actions = { openConnector: () => undefined, openInBrowser: () => undefined };
	expect(readDesktopShellBridge(undefined)).toBeNull();
	expect(readDesktopShellBridge({})).toBeNull();
	expect(readDesktopShellBridge({ clawdiDesktop: null })).toBeNull();
	expect(readDesktopShellBridge({ clawdiDesktop: { ...actions, version: 2 } })).toBeNull();
	expect(
		readDesktopShellBridge({ clawdiDesktop: { version: 1, openConnector: actions.openConnector } }),
	).toBeNull();
	expect(readDesktopShellBridge({ clawdiDesktop: { ...actions, version: 1 } })).not.toBeNull();
});

test("forwards calls to the bridge it detected", () => {
	const openConnector = mock(() => undefined);
	const openInBrowser = mock((_url: string) => undefined);
	const bridge = readDesktopShellBridge({
		clawdiDesktop: Object.freeze({ version: 1, openConnector, openInBrowser }),
	});

	bridge?.openConnector();
	bridge?.openInBrowser("https://cloud.clawdi.ai/?settings=api-keys");

	expect(openConnector).toHaveBeenCalledTimes(1);
	expect(openInBrowser).toHaveBeenCalledWith("https://cloud.clawdi.ai/?settings=api-keys");
});

test("renders the browser experience on the server", () => {
	function Probe() {
		return createElement("span", null, useDesktopShell().inDesktop ? "desktop" : "browser");
	}

	expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>browser</span>");
});
