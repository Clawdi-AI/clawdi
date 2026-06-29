import { describe, expect, test } from "bun:test";
import { deploymentDisplayName } from "@/hosted/agent-identity";

describe("deploymentDisplayName", () => {
	test("keeps user-provided hosted agent names", () => {
		expect(deploymentDisplayName(" Research Agent ")).toBe("Research Agent");
	});

	test("keeps backend-provided deployment names as the display source of truth", () => {
		expect(deploymentDisplayName("v2-hosted-a1b2c3d4")).toBe("v2-hosted-a1b2c3d4");
	});

	test("keeps the existing runtime-prefix cleanup", () => {
		expect(deploymentDisplayName("codex-research")).toBe("research");
		expect(deploymentDisplayName("openclaw-research")).toBe("research");
		expect(deploymentDisplayName("hermes-support")).toBe("support");
	});
});
