import { describe, expect, test } from "bun:test";
import { deployAgentNameAfterRuntimeChange } from "@/hosted/billing/deploy/deploy-defaults";

describe("deploy wizard defaults", () => {
	test("follows runtime display names until the agent name is edited", () => {
		expect(
			deployAgentNameAfterRuntimeChange({
				currentName: "Hermes",
				hasBeenEdited: false,
				runtime: "openclaw",
			}),
		).toBe("OpenClaw");
		expect(
			deployAgentNameAfterRuntimeChange({
				currentName: "Research Assistant",
				hasBeenEdited: true,
				runtime: "hermes",
			}),
		).toBe("Research Assistant");
	});
});
