import { describe, expect, test } from "bun:test";
import { formatShortDate } from "@/lib/format";
import { computeAvailable, computeNow, computeOverviewCases } from "./overview-compute.test-cases";
import { overviewComputePresentation } from "./overview-compute-presentation";

describe("overview Compute presentation", () => {
	test.each(computeOverviewCases)("$name", ({ deployment, expected }) => {
		const result = overviewComputePresentation(deployment, computeAvailable, computeNow);
		expect(result.subscription?.value ?? null).toBe(expected.status);
		expect(result.date).toEqual(
			expected.date
				? {
						label: expected.date[0],
						value: formatShortDate(expected.date[1]),
					}
				: null,
		);
		expect(result.action?.kind).toBe(expected.action);
		expect(result.planLabel).toBe(
			deployment.current_plan_slug === "compute_basic"
				? "Basic plan"
				: deployment.current_plan_slug === "compute_performance"
					? "Performance plan"
					: "Plan unavailable",
		);
	});

	test("availability gates upgrades and new subscriptions, not authorized payment recovery", () => {
		for (const limits of [
			{ canCreateCloudAgents: false },
			{ plansLoading: true },
			{ performancePlanAvailable: false },
		]) {
			for (const { name, deployment, expected } of computeOverviewCases.filter(
				({ expected }) => expected.action,
			)) {
				const result = overviewComputePresentation(
					deployment,
					{ ...computeAvailable, ...limits },
					computeNow,
				);
				const blocked =
					expected.action === "upgrade" ||
					(expected.action === "start_new" && limits.canCreateCloudAgents === false);
				expect(result.action?.kind, name).toBe(blocked ? undefined : expected.action);
			}
		}
	});
});
