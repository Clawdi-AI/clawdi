import type { components } from "@clawdi/shared/api";
import { expect, test } from "@playwright/test";

test("split resolves prefix collisions and preserves source keys after a partial copy", async ({
	page,
}) => {
	const source = {
		id: "11111111-1111-4111-8111-111111111111",
		slug: "source",
		name: "Source",
		project_ids: [],
		is_owner: true,
		item_count: 4,
		created_at: "2026-10-03T00:00:00Z",
	};
	const catalog: components["schemas"]["VaultResponse"][] = [source];
	let names = ["app_a/A", "app_a/B", "app-a/A", "app-a/B"];
	const copied: string[] = [];
	const deleted: string[][] = [];
	await page.route("**/v1/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const respond = (json: unknown) => route.fulfill({ status: 200, json });
		if (url.pathname === "/v1/vault") {
			if (request.method() === "POST") {
				expect(url.searchParams.get("create_only")).toBe("true");
				const body = request.postDataJSON() as components["schemas"]["VaultCreate"];
				const target = {
					...source,
					...body,
					id:
						body.slug === "app-a"
							? "22222222-2222-4222-8222-222222222222"
							: "33333333-3333-4333-8333-333333333333",
					item_count: 0,
				};
				catalog.push(target);
				return respond({ id: target.id, slug: target.slug });
			}
			return respond({ items: catalog, total: catalog.length, page: 1, page_size: 200 });
		}
		if (url.pathname === "/v1/vault/detail") return respond(source);
		if (url.pathname === "/v1/vault/source/items/copy") {
			expect(url.searchParams.get("vault_id")).toBe(source.id);
			const body = request.postDataJSON() as components["schemas"]["VaultItemsCopy"];
			expect(url.searchParams.get("target_vault_id")).toBe(
				catalog.find((v) => v.slug === body.target_slug)?.id,
			);
			expect(body.fields.every((field) => field.startsWith(body.strip_prefix ?? "missing"))).toBe(
				true,
			);
			copied.push(body.target_slug);
			return respond({ status: "ok", copied: body.strip_prefix === "app_a/" ? 1 : 2 });
		}
		if (url.pathname === "/v1/vault/source/items") {
			expect(url.searchParams.get("vault_id")).toBe(source.id);
			if (request.method() === "DELETE") {
				expect(url.searchParams.get("global_delete")).toBe("true");
				const body = request.postDataJSON() as components["schemas"]["VaultItemDelete"];
				deleted.push(body.fields);
				names = names.filter((name) => !body.fields.includes(name));
				return respond({ status: "deleted" });
			}
			return respond({ "(default)": names });
		}
		if (["/v1/vault/requests", "/v1/projects", "/v1/agents"].includes(url.pathname))
			return respond([]);
		return respond({});
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/vaults/source?vault=${source.id}`);
	await page.getByRole("button", { name: "Split into vaults…" }).click();
	const dialog = page.getByRole("dialog", { name: "Split Source by app prefix" });
	const submit = dialog.getByRole("button", { name: "Split 4 keys into 2 vaults" });
	await expect(submit).toBeDisabled();
	await dialog.getByLabel("Destination slug for app_a/").fill("app-underscore");
	await expect(submit).toBeEnabled();
	await submit.click();
	await expect(dialog.getByRole("status")).toContainText("partial");
	await expect(dialog.getByRole("status")).toContainText("source deletion skipped or unconfirmed");
	await expect(dialog.getByRole("link", { name: "vault://app-underscore" })).toHaveAttribute(
		"href",
		/vault=33333333-3333-4333-8333-333333333333/,
	);
	await expect(dialog.getByRole("link", { name: "vault://app-a", exact: true })).toBeVisible();
	expect(copied.sort()).toEqual(["app-a", "app-underscore"]);
	expect(deleted).toEqual([["app-a/A", "app-a/B"]]);
	expect(names).toEqual(["app_a/A", "app_a/B"]);
	await expect(dialog.getByRole("button", { name: /^Split \d+ keys/ })).toBeDisabled();
});
