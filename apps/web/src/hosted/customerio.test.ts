import { describe, expect, mock, test } from "bun:test";
import type { HostedCustomerIOIdentity } from "./customerio";

mock.module("@customerio/cdp-analytics-browser", () => ({
	AnalyticsBrowser: {
		load: () => {
			throw new Error("unexpected default Customer.io loader call");
		},
	},
}));

const {
	createHostedCustomerIOController,
	customerIOBrowserSettings,
	resolveHostedNotificationUrl,
} = await import("./customerio");

const identity: HostedCustomerIOIdentity = {
	customerId: "usr_K8fJ3pQm",
};

function analyticsDouble() {
	return {
		identify: mock(async (_customerId: string) => undefined),
		reset: mock(async () => undefined),
		inbox: () => {
			throw new Error("inbox is not used by this test");
		},
	};
}

describe("Customer.io browser configuration", () => {
	test("uses the official EU CDN override and the US default", () => {
		expect(customerIOBrowserSettings("write_key", "us")).toEqual({ writeKey: "write_key" });
		expect(customerIOBrowserSettings("write_key", "eu")).toEqual({
			writeKey: "write_key",
			cdnURL: "https://cdp-eu.customer.io",
		});
	});

	test("recreates the SDK after readiness fails and keeps pageviews disabled", async () => {
		const analytics = analyticsDouble();
		let attempts = 0;
		const load = mock((_settings, _options) => ({
			analytics,
			ready:
				++attempts === 1 ? Promise.reject(new Error("settings unavailable")) : Promise.resolve(),
		}));
		const controller = createHostedCustomerIOController(
			{ writeKey: "write_key", region: "us" },
			load,
		);

		await expect(controller.syncIdentity(identity)).rejects.toThrow("settings unavailable");
		await controller.syncIdentity(identity);

		expect(load).toHaveBeenCalledTimes(2);
		expect(load.mock.calls[0]?.[1]).toEqual({ initialPageview: false });
	});

	test("identifies only the canonical profile ID without browser-owned traits", async () => {
		const analytics = analyticsDouble();
		const controller = createHostedCustomerIOController(
			{ writeKey: "write_key", region: "us" },
			() => ({ analytics, ready: Promise.resolve() }),
		);

		await controller.syncIdentity(identity);
		await controller.syncIdentity({ ...identity });

		expect(analytics.identify).toHaveBeenCalledTimes(1);
		expect(analytics.identify).toHaveBeenCalledWith("usr_K8fJ3pQm");
	});

	test("clears a persisted SDK identity on the first anonymous sync", async () => {
		const analytics = analyticsDouble();
		const controller = createHostedCustomerIOController(
			{ writeKey: "write_key", region: "us" },
			() => ({ analytics, ready: Promise.resolve() }),
		);

		await controller.syncIdentity(null);
		await controller.syncIdentity(null);

		expect(analytics.reset).toHaveBeenCalledTimes(1);
	});

	test("rejects non-canonical profile IDs before calling the SDK", async () => {
		const analytics = analyticsDouble();
		const load = mock(() => ({ analytics, ready: Promise.resolve() }));
		const controller = createHostedCustomerIOController(
			{ writeKey: "write_key", region: "us" },
			load,
		);

		await expect(controller.syncIdentity({ customerId: "user_clerk_123" })).rejects.toThrow(
			"canonical customer ID",
		);
		expect(load).not.toHaveBeenCalled();
		expect(analytics.identify).not.toHaveBeenCalled();
	});

	test("serializes logout and account switches behind an older identify", async () => {
		const calls: string[] = [];
		let releaseFirstIdentify = () => {};
		let markFirstIdentifyStarted = () => {};
		const firstIdentifyStarted = new Promise<void>((resolve) => {
			markFirstIdentifyStarted = resolve;
		});
		const firstIdentifyPending = new Promise<void>((resolve) => {
			releaseFirstIdentify = resolve;
		});
		const analytics = {
			...analyticsDouble(),
			identify: mock(async (customerId: string) => {
				calls.push(`identify:${customerId}`);
				if (customerId === identity.customerId) {
					markFirstIdentifyStarted();
					await firstIdentifyPending;
				}
			}),
			reset: mock(async () => {
				calls.push("reset");
			}),
		};
		const controller = createHostedCustomerIOController(
			{ writeKey: "write_key", region: "us" },
			() => ({ analytics, ready: Promise.resolve() }),
		);
		const nextIdentity = {
			customerId: "usr_next",
		};

		const first = controller.syncIdentity(identity);
		await firstIdentifyStarted;
		const logout = controller.syncIdentity(null);
		const accountSwitch = controller.syncIdentity(nextIdentity);
		expect(calls).toEqual([`identify:${identity.customerId}`]);

		releaseFirstIdentify();
		await Promise.all([first, logout, accountSwitch]);
		await controller.syncIdentity({ ...nextIdentity });

		expect(calls).toEqual([
			`identify:${identity.customerId}`,
			"reset",
			`identify:${nextIdentity.customerId}`,
		]);
	});
});

describe("Customer.io notification navigation", () => {
	test("allows same-origin relative URLs and only HTTPS external URLs", () => {
		const relative = resolveHostedNotificationUrl("/wallet?tab=reload", "http://localhost:3000");
		expect(relative?.kind).toBe("same-origin");
		expect(relative?.url.href).toBe("http://localhost:3000/wallet?tab=reload");

		const external = resolveHostedNotificationUrl(
			"https://docs.clawdi.ai/wallet",
			"https://cloud.clawdi.ai",
		);
		expect(external?.kind).toBe("external");
		expect(resolveHostedNotificationUrl("http://docs.clawdi.ai", "https://cloud.clawdi.ai")).toBe(
			null,
		);
		expect(resolveHostedNotificationUrl("javascript:alert(1)", "https://cloud.clawdi.ai")).toBe(
			null,
		);
	});
});
