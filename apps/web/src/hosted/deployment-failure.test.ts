import { describe, expect, test } from "bun:test";
import { deploymentFailureReason } from "@/hosted/deployment-failure";

describe("deploymentFailureReason", () => {
	test("uses the compatibility Problem title instead of internal detail", () => {
		expect(
			deploymentFailureReason({
				failure: {
					title: "Runtime startup failed",
					conditionMessage: "The runtime did not become ready.",
				},
			}),
		).toBe("Runtime startup failed");
	});

	test("falls back to the condition message when the title is empty", () => {
		expect(
			deploymentFailureReason({
				failure: { title: "  ", conditionMessage: "The runtime did not become ready." },
			}),
		).toBe("The runtime did not become ready.");
	});
});
