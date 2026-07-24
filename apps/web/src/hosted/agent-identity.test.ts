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

	test("uses the runtime label for generated or missing deployment names", () => {
		const id = "b9fea25e-2a83-4de7-b80c-65b3c118f65f";
		expect(deploymentDisplayName("", "openclaw")).toBe("OpenClaw");
		expect(deploymentDisplayName(id, "hermes")).toBe("Hermes");
		expect(deploymentDisplayName(`deployment-create-${id}`, "openclaw")).toBe("OpenClaw");
		expect(deploymentDisplayName(`openclaw-${id}`, "openclaw")).toBe("OpenClaw");
		expect(deploymentDisplayName(`hermes-deployment-create-${id}`, "hermes")).toBe("Hermes");
	});
});
