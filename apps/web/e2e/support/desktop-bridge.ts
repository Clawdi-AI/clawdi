import type { Page } from "@playwright/test";

/** Stands in for Clawdi Desktop's preload bridge and records every call. */
export async function injectDesktopBridge(page: Page) {
	await page.addInitScript(() => {
		const calls: string[][] = [];
		Object.defineProperty(window, "__clawdiDesktopCalls", { value: calls });
		Object.defineProperty(window, "clawdiDesktop", {
			value: Object.freeze({
				version: 1,
				openConnector: () => calls.push(["openConnector"]),
				createDashboardSession: async () => {
					calls.push(["createDashboardSession"]);
					return { ticket: "e2e-ticket", accountId: "user_e2e" };
				},
				signOut: async () => {
					calls.push(["signOut"]);
				},
			}),
		});
	});
}

export function desktopBridgeCalls(page: Page): Promise<string[][]> {
	return page.evaluate(() => Reflect.get(window, "__clawdiDesktopCalls"));
}
