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

test("popular BYOK providers have branded icons and credential-only product setup", async ({
	page,
}, testInfo) => {
	const errors = collectBrowserErrors(page);
	const inferenceRequests: string[] = [];
	page.on("request", (request) => {
		if (/\/ai-providers\/(?:[^/]+\/)?test(?:\?|$)/.test(request.url()))
			inferenceRequests.push(request.url());
	});
	await page.addInitScript(() => localStorage.setItem("clawdi-theme", "system"));
	await page.setViewportSize({ width: 1000, height: 1000 });
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto("/ai-providers");
	await page.getByRole("button", { name: "Add provider", exact: true }).first().click();
	const dialog = page.getByRole("dialog");
	const brands = [
		"NVIDIA NIM",
		"Fireworks AI",
		"Hugging Face",
		"DeepInfra",
		"OpenCode",
		"Xiaomi MiMo API",
		"Tencent Cloud",
	];
	for (const theme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: theme });
		if (theme === "dark") await page.setViewportSize({ width: 390, height: 844 });
		for (const brand of brands) {
			const card = dialog.getByRole("button", { name: new RegExp(`^${brand}`) });
			await card.scrollIntoViewIfNeeded();
			await expect(card.locator('svg[data-icon-source="lobehub"]')).toBeVisible();
		}
		await dialog.screenshot({ path: testInfo.outputPath(`provider-icons-${theme}.png`) });
	}
	for (const choice of [
		{
			query: "Hugging Face",
			name: "Hugging Face",
			id: "huggingface",
			variant: null,
			product: null,
			credential: "Access token",
		},
		{
			query: "Go",
			name: "OpenCode",
			id: "opencode",
			variant: "go",
			product: "Go",
			credential: "API key",
		},
		{
			query: "TokenPlan",
			name: "Tencent Cloud",
			id: "tencent",
			variant: "tokenplan",
			product: "TokenPlan",
			credential: "API key",
		},
	]) {
		await dialog.getByRole("textbox", { name: "Search providers" }).fill(choice.query);
		await dialog.getByRole("button", { name: new RegExp(`^${choice.name}`) }).click();
		await expect(
			dialog.locator('[data-slot="dialog-title"] svg[data-icon-source="lobehub"]'),
		).toBeVisible();
		await expect(dialog.getByText("Choose and manage models inside your agent.")).toHaveCount(0);
		await expect(dialog.getByText("Encrypted at rest and never shown again.")).toHaveCount(0);
		const credentialInput = dialog.getByLabel(choice.credential, { exact: true });
		await expect(credentialInput).toHaveAttribute(
			"placeholder",
			choice.credential === "API key" ? "Enter API key" : "Enter access token",
		);
		await expect(
			dialog.getByRole("button", {
				name: choice.credential === "API key" ? "Show API key" : "Show access token",
				exact: true,
			}),
		).toBeVisible();
		await dialog.screenshot({ path: testInfo.outputPath(`provider-setup-${choice.id}.png`) });
		if (choice.product) {
			await dialog.getByRole("combobox", { name: "Product", exact: true }).click();
			await page.getByRole("option", { name: choice.product, exact: true }).click();
		}
		await expect(dialog.getByLabel("Model catalog")).toHaveCount(0);
		await expect(dialog.getByLabel("Base URL")).toHaveCount(0);
		await expect(dialog.getByRole("button", { name: "Test connection", exact: true })).toHaveCount(
			0,
		);
		await dialog
			.getByLabel(choice.credential, { exact: true })
			.fill("synthetic-provider-credential");
		const request = page.waitForRequest(
			(item) => item.url().endsWith("/ai-providers/accept") && item.method() === "POST",
		);
		await dialog.getByRole("button", { name: "Add provider", exact: true }).click();
		expect((await request).postDataJSON().provider).toMatchObject({
			configuration_mode: "native",
			native_provider: choice.id,
			native_variant: choice.variant,
			models: null,
		});
		await expect(dialog).toBeHidden();
		if (choice.variant !== "tokenplan")
			await page.getByRole("button", { name: "Add provider", exact: true }).first().click();
	}
	expect(inferenceRequests).toEqual([]);
	expect(errors).toEqual([]);
});
