import { describe, expect, test } from "bun:test";
import { skillSearchSupportingText } from "@/components/skills/skill-search";
import { vaultSearchRank, vaultSearchSupportingText } from "@/components/vault/vault-search";

describe("asset search presentation", () => {
	test("reveals a long Skill description match", () => {
		const supporting = {
			skill_key: "runbook",
			name: "Runbook",
			description: `${"before ".repeat(30)}release handoff${" after".repeat(30)}`,
		};

		expect(skillSearchSupportingText(supporting, "release handoff")).toContain("release handoff");
	});

	test("orders Vault names before slugs and explains slug-only matches", () => {
		const nameMatch = { name: "Production", slug: "shared-secrets" };
		const slugMatch = { name: "Shared secrets", slug: "production" };

		expect(vaultSearchRank(nameMatch, "production")).toBe(0);
		expect(vaultSearchRank(slugMatch, "production")).toBe(1);
		expect(vaultSearchSupportingText(slugMatch, "production")).toBe("Slug: production");
	});
});
