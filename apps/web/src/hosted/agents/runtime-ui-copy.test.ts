import { describe, expect, test } from "bun:test";
import { hermesPasswordUiCopy, openClawNativeUiCopy } from "@/hosted/agents/runtime-ui-copy";

describe("runtime password UI copy", () => {
	test("localizes simplified and traditional Chinese browser locales", () => {
		expect(hermesPasswordUiCopy("zh-CN").title).toBe("使用显式凭据打开 Hermes");
		expect(hermesPasswordUiCopy("zh-Hant").title).toBe("使用明確憑證開啟 Hermes");
	});

	test("falls back to English for unsupported and server locales", () => {
		expect(hermesPasswordUiCopy("fr-FR").title).toBe("Open Hermes with explicit credentials");
		expect(hermesPasswordUiCopy(undefined).viewCredentials).toBe("View Hermes credentials");
		expect(hermesPasswordUiCopy(undefined).openDashboard).toBe("Open Hermes Dashboard");
	});

	test("keeps the official exact-requestId pairing workflow in every catalog", () => {
		for (const locale of ["en", "zh-CN", "zh-Hant"]) {
			const copy = openClawNativeUiCopy(locale);
			expect(copy.pairingListCommand).toBe("openclaw devices list");
			expect(copy.pairingApproveCommand).toBe("openclaw devices approve <requestId>");
			expect(copy.pairingWarning).toContain("--latest");
			expect(copy.pairingApprove).not.toBe("");
			expect(copy.pairingRequestId).not.toBe("");
		}
	});
});
