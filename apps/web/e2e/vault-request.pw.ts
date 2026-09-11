import { expect, test } from "@playwright/test";

const token = "a".repeat(43);
const context = {
	id: "11111111-1111-4111-8111-111111111111",
	vault_id: "22222222-2222-4222-8222-222222222222",
	project_id: "33333333-3333-4333-8333-333333333333",
	vault_name: "Production API",
	project_name: "Agent workspace",
	slug: "production-api",
	section: "",
	fields: ["API_KEY", "API_SECRET"],
	status: "pending",
	expires_at: "2099-01-01T00:00:00Z",
	supplied_at: null,
	references: {},
	local_command: "",
};

test("public batch request keeps capability out of URLs and saves all fields once", async ({
	page,
}) => {
	let submissions = 0;
	const requestedUrls: string[] = [];
	page.on("request", (request) => requestedUrls.push(request.url()));
	await page.route("**/v1/vault/requests/**", async (route) => {
		const request = route.request();
		expect(request.method()).toBe("POST");
		expect(request.headers().referer).toBeUndefined();
		expect(request.postDataJSON().token).toBe(token);
		if (request.url().endsWith("/supply")) {
			submissions++;
			expect(request.postDataJSON().fields).toEqual({
				API_KEY: "fake-key",
				API_SECRET: "line1\nline2",
			});
			return route.fulfill({
				json: { ...context, status: "supplied", supplied_at: "2026-09-10T00:00:00Z" },
			});
		}
		return route.fulfill({ json: context });
	});
	const response = await page.goto(`/vault-request#${token}`);
	expect(response?.headers()["cache-control"]).toContain("no-store");
	await expect(page.getByText("Production API · Agent workspace")).toBeVisible();
	await expect(page).toHaveURL(/\/vault-request$/);
	await page.getByLabel("API_KEY", { exact: true }).fill("fake-key");
	await page.getByLabel("API_SECRET", { exact: true }).fill("line1\nline2");
	await page.getByRole("button", { name: "Save secrets" }).click();
	await expect(page.getByRole("status")).toContainText("Your secrets are saved");
	expect(submissions).toBe(1);
	expect(requestedUrls.some((url) => url.includes(token))).toBe(false);
	await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("expired capability offers no secret form", async ({ page }) => {
	await page.route("**/v1/vault/requests/inspect", (route) =>
		route.fulfill({ status: 410, json: { detail: "Secret request unavailable" } }),
	);
	await page.goto(`/vault-request#${token}`);
	await expect(page.getByRole("alert")).toContainText("expired");
	await expect(page.getByRole("textbox")).toHaveCount(0);
});
