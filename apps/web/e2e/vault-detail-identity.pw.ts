import { expect, type Route, test } from "@playwright/test";

const now = "2026-07-14T12:00:00.000Z";
const sharedId = "11111111-1111-4111-8111-111111111111";
const ownedId = "22222222-2222-4222-8222-222222222222";

const vaults = [
	{
		id: sharedId,
		slug: "collision",
		name: "Shared Collision",
		project_id: "project-shared",
		project_ids: ["project-shared"],
		is_owner: false,
		item_count: 1,
		created_at: now,
	},
	{
		id: ownedId,
		slug: "collision",
		name: "Owned Collision",
		project_id: "project-owned",
		project_ids: ["project-owned"],
		is_owner: true,
		item_count: 1,
		created_at: now,
	},
];

async function fulfill(route: Route, body: unknown) {
	await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test("same-slug Vault cards preserve UUID identity through detail and cache", async ({ page }) => {
	const keysByVault = new Map([
		[sharedId, ["SHARED_ONLY"]],
		[ownedId, ["OWNED_ONLY"]],
	]);
	const upsertedVaultIds: string[] = [];
	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/v1/agents") return fulfill(route, []);
		if (url.pathname === "/v1/vault") {
			return fulfill(route, { items: vaults, total: 2, page: 1, page_size: 25 });
		}
		if (url.pathname === "/v1/vault/detail") {
			const id = url.searchParams.get("vault_id");
			return fulfill(
				route,
				vaults.find((vault) => vault.id === id),
			);
		}
		if (url.pathname === "/v1/vault/collision/items") {
			const id = url.searchParams.get("vault_id");
			if (route.request().method() === "PUT") {
				if (id) upsertedVaultIds.push(id);
				const body = route.request().postDataJSON() as { fields: Record<string, string> };
				if (id) keysByVault.set(id, [...(keysByVault.get(id) ?? []), ...Object.keys(body.fields)]);
				return fulfill(route, { status: "ok", fields: Object.keys(body.fields).length });
			}
			return fulfill(route, {
				"(default)": id ? (keysByVault.get(id) ?? []) : [],
			});
		}
		if (url.pathname === "/v1/projects") {
			return fulfill(route, [
				{
					id: "project-shared",
					name: "Shared",
					slug: "shared",
					kind: "workspace",
					is_owner: false,
					created_at: now,
				},
				{
					id: "project-owned",
					name: "Owned",
					slug: "owned",
					kind: "personal",
					is_owner: true,
					created_at: now,
				},
			]);
		}
		return fulfill(route, {});
	});

	await page.goto("/vault");
	await page.getByRole("link", { name: "Open vault Shared Collision" }).click();
	await expect(page).toHaveURL(new RegExp(`/vault/collision\\?vault=${sharedId}$`));
	await expect(page.getByRole("heading", { name: "Shared Collision" })).toBeVisible();
	await expect(page.getByText("SHARED_ONLY", { exact: true })).toBeVisible();
	await expect(page.getByText("OWNED_ONLY", { exact: true })).toHaveCount(0);

	await page.getByLabel("breadcrumb").getByRole("link", { name: "Vaults" }).click();
	await page.getByRole("link", { name: "Open vault Owned Collision" }).click();
	await expect(page).toHaveURL(new RegExp(`/vault/collision\\?vault=${ownedId}$`));
	await expect(page.getByRole("heading", { name: "Owned Collision" })).toBeVisible();
	await expect(page.getByText("OWNED_ONLY", { exact: true })).toBeVisible();
	await expect(page.getByText("SHARED_ONLY", { exact: true })).toHaveCount(0);

	await page.getByRole("button", { name: "Add keys" }).click();
	await page.getByPlaceholder(/OPENAI_API_KEY/).fill("ADDED_TO_OWNED=secret-value");
	await page.getByRole("button", { name: "Save 1" }).click();
	await expect(page.getByText("ADDED_TO_OWNED", { exact: true })).toBeVisible();
	expect(upsertedVaultIds).toEqual([ownedId]);
	expect(keysByVault.get(sharedId)).toEqual(["SHARED_ONLY"]);
});
