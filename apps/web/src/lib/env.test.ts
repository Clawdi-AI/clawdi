import { describe, expect, test } from "bun:test";
import { isDevAuthBypassEnabled, isProductionRuntime } from "./env";

describe("dev auth bypass env guard", () => {
	test("keeps the bypass available in local development", () => {
		expect(
			isDevAuthBypassEnabled({
				MODE: "development",
				NODE_ENV: "development",
				VITE_DEV_AUTH_BYPASS: "true",
			}),
		).toBe(true);
	});

	test("treats NODE_ENV=production as authoritative over MODE", () => {
		expect(
			isProductionRuntime({
				MODE: "development",
				NODE_ENV: "production",
			}),
		).toBe(true);
		expect(
			isDevAuthBypassEnabled({
				MODE: "development",
				NODE_ENV: "production",
				VITE_DEV_AUTH_BYPASS: "true",
			}),
		).toBe(false);
	});

	test("disables the bypass for production Vite builds", () => {
		expect(
			isDevAuthBypassEnabled({
				MODE: "production",
				NODE_ENV: "development",
				VITE_DEV_AUTH_BYPASS: "true",
			}),
		).toBe(false);
	});
});
