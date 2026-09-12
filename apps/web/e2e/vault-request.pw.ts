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

for (const update_fields of [[], ["API_KEY"]]) {
	test(`public ${update_fields.length ? "mixed" : "new"} batch keeps capability private and saves once`, async ({
		page,
		context: browserContext,
	}, testInfo) => {
		await browserContext.grantPermissions(["clipboard-read", "clipboard-write"]);
		const suppliedId = "44444444-4444-4444-8444-444444444444";
		const message = `I've saved the requested credentials. Please check Vault request ${suppliedId}; once its status is supplied, continue our previous task using existing authorized capabilities. Do not include secret values in chat.`;
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
					json: {
						...context,
						id: suppliedId,
						status: "supplied",
						supplied_at: "2026-09-10T00:00:00Z",
					},
				});
			}
			return route.fulfill({ json: { ...context, update_fields } });
		});
		const response = await page.goto(`/vault-request#${token}`);
		expect(response?.headers()["cache-control"]).toContain("no-store");
		await expect(page.getByText("Production API · Agent workspace")).toBeVisible();
		await expect(page).toHaveURL(/\/vault-request$/);
		await expect(page.getByRole("button", { name: "Copy message for agent" })).toHaveCount(0);
		await expect(page.getByLabel("API_KEY", { exact: true })).toHaveValue("");
		await expect(page.getByLabel("API_SECRET", { exact: true })).toHaveValue("");
		await expect(page.getByText("Update", { exact: true })).toHaveCount(update_fields.length);
		const screenshot = testInfo.outputPath("request-form.png");
		await page.screenshot({ path: screenshot });
		await testInfo.attach("request-form", { path: screenshot, contentType: "image/png" });
		await page.getByLabel("API_KEY", { exact: true }).fill("fake-key");
		await page.getByLabel("API_SECRET", { exact: true }).fill("line1\nline2");
		await page.getByRole("button", { name: "Save secrets" }).click();
		await expect(page.getByRole("status")).toContainText("Your secrets are saved");
		expect(submissions).toBe(1);
		expect(requestedUrls.some((url) => url.includes(token))).toBe(false);
		await expect(page.getByRole("textbox")).toHaveCount(0);
		await expect(page.getByText(message, { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Copy message for agent" }).click();
		await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(message);

		// Hold a denied write pending to verify success is never reported before settlement.
		await page.evaluate(() => {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: () =>
						new Promise<void>((_resolve, reject) => {
							window.addEventListener(
								"deny-copy",
								() => reject(new DOMException("Denied", "NotAllowedError")),
								{ once: true },
							);
						}),
				},
			});
		});
		await page.getByRole("button", { name: "Copied", exact: true }).click();
		await expect(page.getByRole("button", { name: "Copying…" })).toBeDisabled();
		await expect(page.getByRole("button", { name: "Copied", exact: true })).toHaveCount(0);
		await page.evaluate(() => window.dispatchEvent(new Event("deny-copy")));
		await expect(page.getByRole("alert")).toContainText("copy the message above manually");
		await expect(page.getByText(message, { exact: true })).toBeVisible();

		await page.evaluate(() =>
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }),
		);
		await page.getByRole("button", { name: "Copy message for agent" }).click();
		await expect(page.getByRole("alert")).toContainText("copy the message above manually");
		await expect(page.getByRole("button", { name: "Copied", exact: true })).toHaveCount(0);
		expect(submissions).toBe(1);
	});
}

test("expired capability offers no secret form", async ({ page }) => {
	await page.route("**/v1/vault/requests/inspect", (route) =>
		route.fulfill({ status: 410, json: { detail: "Secret request unavailable" } }),
	);
	await page.goto(`/vault-request#${token}`);
	await expect(page.getByRole("alert")).toContainText("expired");
	await expect(page.getByRole("button", { name: "Copy message for agent" })).toHaveCount(0);
	await expect(page.getByRole("textbox")).toHaveCount(0);
});

for (const status of ["missing", "error"]) {
	test(`${status} request offers no agent message`, async ({ page }) => {
		await page.route("**/v1/vault/requests/inspect", (route) =>
			route.fulfill({ status: 500, json: { detail: "Unavailable" } }),
		);
		await page.goto(status === "missing" ? "/vault-request" : `/vault-request#${token}`);
		await expect(page.getByRole("alert")).toBeVisible();
		await expect(page.getByRole("button", { name: "Copy message for agent" })).toHaveCount(0);
	});
}

test("an intervening change clears the mixed form without claiming success", async ({ page }) => {
	await page.route("**/v1/vault/requests/inspect", (route) =>
		route.fulfill({ json: { ...context, update_fields: ["API_KEY"] } }),
	);
	await page.route("**/v1/vault/requests/supply", (route) =>
		route.fulfill({ status: 410, json: { detail: "Secret request unavailable" } }),
	);
	await page.goto(`/vault-request#${token}`);
	await page.getByLabel("API_KEY", { exact: true }).fill("synthetic-update");
	await page.getByLabel("API_SECRET", { exact: true }).fill("synthetic-new");
	await page.getByRole("button", { name: "Save secrets" }).click();
	await expect(page.getByRole("alert")).toContainText("new link");
	await expect(page.getByRole("textbox")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Copy message for agent" })).toHaveCount(0);
});
