import { describe, expect, test } from "bun:test";
import { type LatestActionRef, latestAction } from "@/hosted/billing/deploy/latest-action";

describe("latestAction", () => {
	test("a toast created by a blocked render invokes the retry from the latest render", () => {
		let attempts = 0;
		const ref: LatestActionRef = {
			current: () => {
				// This models onDeploy while submitting=true.
			},
		};
		const retry = latestAction(ref);

		// The failed submission settles and React publishes a fresh onDeploy closure.
		ref.current = () => {
			attempts += 1;
		};
		retry();

		expect(attempts).toBe(1);
	});
});
