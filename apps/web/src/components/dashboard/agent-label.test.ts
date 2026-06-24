import { describe, expect, test } from "bun:test";
import { cleanMachineName } from "@/components/dashboard/agent-label";

describe("cleanMachineName", () => {
	test("strips local network suffixes", () => {
		expect(cleanMachineName("devbook.local")).toBe("devbook");
		expect(cleanMachineName("lab.lan")).toBe("lab");
	});

	test("keeps backend-provided machine names as the display source of truth", () => {
		expect(cleanMachineName("v2-hosted-a1b2c3d4")).toBe("v2-hosted-a1b2c3d4");
	});
});
