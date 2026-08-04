import { describe, expect, test } from "bun:test";
import type { components } from "@/lib/api-schemas";
import { resolveLegacyVaultSummary } from "./vault-detail-resolution";

type Vault = components["schemas"]["VaultResponse"];

function vault(id: string, slug: string): Vault {
	return {
		id,
		slug,
		name: id,
		project_ids: [],
		is_owner: true,
		item_count: 0,
		created_at: "2026-08-01T00:00:00Z",
	};
}

describe("legacy Vault detail resolution", () => {
	test("returns one exact slug match and ignores fuzzy name matches", () => {
		expect(
			resolveLegacyVaultSummary([vault("exact", "github"), vault("fuzzy", "github-prod")], "github")
				?.id,
		).toBe("exact");
	});

	test("surfaces same-slug ambiguity instead of selecting the first row", () => {
		expect(() =>
			resolveLegacyVaultSummary([vault("first", "shared"), vault("second", "shared")], "shared"),
		).toThrow("Multiple visible Vaults");
	});
});
