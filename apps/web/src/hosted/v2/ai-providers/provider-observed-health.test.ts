import { describe, expect, test } from "bun:test";
import { providerObservedHealth } from "@/hosted/v2/ai-providers/provider-observed-health";

function summary(
	healthStatus: "ok" | "error" | "stale" | "unknown" | "not_configured",
	providerStatus: "ok" | "error" | "unknown" | "not_configured",
	reasons: string[] = [],
): Parameters<typeof providerObservedHealth>[1] {
	return {
		items: [
			{
				health: { status: healthStatus, reasons, observed_at: null },
				provider_health: [
					{
						provider_id: "openai",
						status: providerStatus,
						reasons,
						desired: { selected: true, primary: true },
						observed: null,
					},
				],
			},
		],
	};
}

describe("providerObservedHealth", () => {
	test.each([
		["missing", undefined],
		["stale", summary("stale", "ok")],
		["unknown", summary("unknown", "unknown")],
	] as const)("does not present %s runtime evidence as healthy", (_label, observed) => {
		expect(providerObservedHealth("openai", observed).status).toBe("unobserved");
	});

	test("presents a provider as healthy only with fresh runtime and provider evidence", () => {
		expect(providerObservedHealth("openai", summary("ok", "ok"))).toEqual({
			status: "ok",
			agentCount: 1,
			reason: null,
		});
	});

	test("surfaces observed provider failures with a safe reason", () => {
		expect(providerObservedHealth("openai", summary("error", "error", ["secret_missing"]))).toEqual(
			{
				status: "degraded",
				agentCount: 1,
				reason: "The runtime cannot access this provider credential.",
			},
		);
	});

	test("expires an old provider failure instead of keeping a permanent red state", () => {
		expect(
			providerObservedHealth(
				"openai",
				summary("error", "error", ["runtime_observed_stale", "secret_missing"]),
			),
		).toEqual({
			status: "unobserved",
			agentCount: 1,
			reason: null,
		});
	});

	test("clears degraded state when the latest fresh observation succeeds", () => {
		expect(providerObservedHealth("openai", summary("error", "error"))).toMatchObject({
			status: "degraded",
		});
		expect(providerObservedHealth("openai", summary("ok", "ok"))).toEqual({
			status: "ok",
			agentCount: 1,
			reason: null,
		});
	});
});
