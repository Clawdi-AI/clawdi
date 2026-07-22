import { describe, expect, test } from "bun:test";
import { hermesPasswordUiCopy } from "@/hosted/agents/runtime-ui-copy";

describe("runtime password UI copy", () => {
	test("localizes simplified and traditional Chinese browser locales", () => {
		expect(hermesPasswordUiCopy("zh-CN").title).toBe("使用 Dashboard 密码打开 Hermes");
		expect(hermesPasswordUiCopy("zh-Hant").title).toBe("使用 Dashboard 密碼開啟 Hermes");
	});

	test("falls back to English for unsupported and server locales", () => {
		expect(hermesPasswordUiCopy("fr-FR").title).toBe("Open Hermes with your dashboard password");
		expect(hermesPasswordUiCopy(undefined).openHermesDashboard).toBe("Copy password & open Hermes");
	});
});
