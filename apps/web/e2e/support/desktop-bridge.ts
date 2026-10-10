import type { Page } from "@playwright/test";

export type DesktopBridgeCall = ["openConnector"] | ["openInBrowser", string];

/** Stands in for Clawdi Desktop's preload bridge and records every call. */
export async function injectDesktopBridge(page: Page) {
	await page.addInitScript(() => {
		const calls: unknown[] = [];
		Object.defineProperty(window, "__clawdiDesktopCalls", { value: calls });
		Object.defineProperty(window, "clawdiDesktop", {
			value: Object.freeze({
				version: 1,
				openConnector: () => calls.push(["openConnector"]),
				openInBrowser: (url: string) => calls.push(["openInBrowser", url]),
			}),
		});
	});
}

export function desktopBridgeCalls(page: Page): Promise<DesktopBridgeCall[]> {
	return page.evaluate(() => Reflect.get(window, "__clawdiDesktopCalls"));
}
