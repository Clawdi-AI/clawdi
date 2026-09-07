import { expect, test } from "@playwright/test";
import { collectBrowserErrors, stubCloudApi } from "./hosted-fixtures";

test.beforeEach(async ({ page }) => {
	await stubCloudApi(page);
});
test("native BYOK saves credentials without a model catalog or inference probe", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const inferenceRequests: string[] = [];
	page.on("request", (request) => {
		if (/\/ai-providers\/(?:[^/]+\/)?test(?:\?|$)/.test(request.url()))
			inferenceRequests.push(request.url());
	});

	await page.goto("/ai-providers");
	await expect(page.getByRole("heading", { name: "AI Providers" })).toBeVisible();
	await page.getByRole("button", { name: "Add provider" }).first().click();
	await expect(page.getByRole("dialog", { name: "Add a provider" })).toBeVisible();

	// The chooser gates the fields: pick a provider first.
	await page.getByRole("button", { name: /^OpenAI/ }).click();
	await page.getByRole("textbox", { name: "API key" }).fill("sk-e2e-test-key");
	await expect(page.getByLabel("Model catalog")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Test connection", exact: true })).toHaveCount(0);
	const acceptedRequest = page.waitForRequest(
		(request) => request.url().endsWith("/ai-providers/accept") && request.method() === "POST",
	);
	await page.getByRole("button", { name: "Add provider", exact: true }).click();
	expect((await acceptedRequest).postDataJSON().provider).toMatchObject({
		configuration_mode: "native",
		native_provider: "openai",
		models: null,
	});

	await expect(page.getByRole("dialog", { name: /Set up OpenAI/ })).toBeHidden();
	// The provider icon carries an SVG <title>OpenAI</title> (always hidden) —
	// assert on a visible text node instead.
	await expect(
		page.getByText("OpenAI", { exact: true }).locator("visible=true").first(),
	).toBeVisible();
	expect(inferenceRequests).toEqual([]);
	expect(errors, `providers flow: ${errors.join(" | ")}`).toEqual([]);
});

test("channels connect dialog opens without browser errors", async ({ page }) => {
	const errors = collectBrowserErrors(page);
	await page.goto("/channels");

	const connect = page.getByRole("button", { name: "Add channel" }).first();
	await expect(connect).toBeVisible();
	expect(errors, `channels render: ${errors.join(" | ")}`).toEqual([]);

	await connect.click();
	await expect(page.getByRole("dialog", { name: "Add channel" })).toBeVisible();
	await page.waitForTimeout(150);
	expect(errors, `connect dialog: ${errors.join(" | ")}`).toEqual([]);
});
