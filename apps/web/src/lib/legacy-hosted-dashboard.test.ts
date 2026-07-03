import { describe, expect, it } from "bun:test";
import { isLegacyHostedDashboardUrlAvailable } from "@/lib/legacy-hosted-dashboard";

describe("isLegacyHostedDashboardUrlAvailable", () => {
	it("treats production URLs as configured without browser host gating", () => {
		expect(isLegacyHostedDashboardUrlAvailable("https://legacy.example.com/dashboard", null)).toBe(
			true,
		);
	});

	it("only exposes localhost defaults to localhost browser sessions", () => {
		expect(isLegacyHostedDashboardUrlAvailable("http://localhost:3000/dashboard", null)).toBe(
			false,
		);
		expect(
			isLegacyHostedDashboardUrlAvailable("http://localhost:3000/dashboard", "cloud.clawdi.ai"),
		).toBe(false);
		expect(
			isLegacyHostedDashboardUrlAvailable("http://localhost:3000/dashboard", "localhost"),
		).toBe(true);
	});
});
