import { describe, expect, test } from "bun:test";
import { slugFromVaultName } from "./vault-slug";

describe("slugFromVaultName", () => {
	test("normalizes vault display names to backend slugs", () => {
		expect(slugFromVaultName("OpenAI Production")).toBe("openai-production");
		expect(slugFromVaultName("  GitHub___Tokens  ")).toBe("github-tokens");
		expect(slugFromVaultName("!!!")).toBe("");
	});
});
