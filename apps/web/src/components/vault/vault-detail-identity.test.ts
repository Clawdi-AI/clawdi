import { describe, expect, test } from "bun:test";
import type { components } from "@/lib/api-schemas";
import { selectVaultForDetail, vaultDetailSearch } from "./vault-detail-identity";

type VaultSummary = components["schemas"]["VaultResponse"];

const shared = { id: "shared-id", slug: "prod", project_ids: ["shared-project"] } as VaultSummary;
const owned = { id: "owned-id", slug: "prod", project_ids: ["owned-project"] } as VaultSummary;

describe("vault list-to-detail identity", () => {
	test("the owned card selects its exact vault and preserves its API project context", () => {
		const search = vaultDetailSearch(owned);
		const selected = selectVaultForDetail([shared, owned], "prod", search.vault);

		expect(search).toEqual({ vault: "owned-id" });
		expect(selected?.id).toBe("owned-id");
		expect(selected?.project_ids?.[0]).toBe("owned-project");
	});

	test("legacy slug-only URLs retain first-match compatibility", () => {
		expect(selectVaultForDetail([shared, owned], "prod")?.id).toBe("shared-id");
	});

	test("an identity from another slug does not select an unrelated vault", () => {
		expect(selectVaultForDetail([owned], "other", "owned-id")).toBeNull();
	});
});
