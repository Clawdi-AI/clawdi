import { expect, test } from "bun:test";
import type { components } from "../api/api.generated";
import { projectVaultCatalogRows } from "./project-vault-catalog";

type Vault = components["schemas"]["VaultResponse"];
const vault: Vault = {
	id: "vault",
	slug: "prod",
	name: "Production",
	item_count: 3,
	created_at: "2026-01-01T00:00:00Z",
	project_ids: ["project", "other"],
	is_owner: true,
};
test("newer scoped snapshot removes a stale Project link without losing other links", () => {
	const rows = projectVaultCatalogRows({
		projectId: "project",
		attachedVaults: [],
		attachedVaultsUpdatedAt: 20,
		catalogVaults: [vault],
		catalogUpdatedAt: 10,
		search: "",
	});
	expect(rows[0]?.project_ids).toEqual(["other"]);
});
test("newer scoped snapshot retains attached metadata and unions other Project links", () => {
	const rows = projectVaultCatalogRows({
		projectId: "project",
		attachedVaults: [{ ...vault, item_count: 5, project_ids: ["project"] }],
		attachedVaultsUpdatedAt: 20,
		catalogVaults: [{ ...vault, project_ids: ["other"] }],
		catalogUpdatedAt: 10,
		search: "Production",
	});
	expect(rows[0]?.item_count).toBe(5);
	expect(rows[0]?.project_ids).toEqual(["other", "project"]);
});
test("unknown links do not replace the newer account catalog; search excludes nonmatches", () => {
	expect(
		projectVaultCatalogRows({
			projectId: "project",
			attachedVaults: undefined,
			attachedVaultsUpdatedAt: 0,
			catalogVaults: [vault],
			catalogUpdatedAt: 10,
			search: "",
		})[0]?.project_ids,
	).toEqual(["project", "other"]);
	expect(
		projectVaultCatalogRows({
			projectId: "project",
			attachedVaults: [vault],
			attachedVaultsUpdatedAt: 20,
			catalogVaults: [],
			catalogUpdatedAt: 10,
			search: "missing",
		}),
	).toEqual([]);
});
