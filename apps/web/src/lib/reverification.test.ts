import { expect, test } from "bun:test";
import { requiresCloudReverification, requiresHostedReverification } from "./reverification";

test("API key management requires step-up; other Cloud reads remain available", () => {
	for (const [method, path] of [
		["GET", "/v1/auth/keys"],
		["POST", "/v1/auth/keys"],
		["DELETE", "/v1/auth/keys/key-id"],
	]) {
		expect(requiresCloudReverification(method ?? "", path ?? "")).toBe(true);
	}
	expect(requiresCloudReverification("GET", "/v1/auth/me")).toBe(false);
	expect(requiresCloudReverification("GET", "/v1/agents")).toBe(false);
});

test("Hosted payment entry, auto-reload and plan mutations require step-up", () => {
	for (const path of [
		"/v2/wallet/auto-reload/setup-intent",
		"/v2/wallet/auto-reload/setup-intent/finalize",
		"/v2/subscription/plan/change",
		"/v2/subscription/portal",
		"/v2/subscription/fix-payment",
		"/v2/wallet/topup",
	]) {
		expect(requiresHostedReverification("POST", path)).toBe(true);
	}
	expect(requiresHostedReverification("PUT", "/v2/wallet/auto-reload")).toBe(true);
	expect(requiresHostedReverification("GET", "/v2/wallet")).toBe(false);
	expect(requiresHostedReverification("POST", "/v2/subscription/plan/quote")).toBe(false);
});
