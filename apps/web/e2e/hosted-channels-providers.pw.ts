import { expect, test } from "@playwright/test";
import { collectBrowserErrors, stubCloudApi } from "./hosted-fixtures";

test.beforeEach(async ({ page }) => {
	await stubCloudApi(page);
});

for (const kind of ["api-key", "oauth"] as const) {
	test(`renaming a native ${kind} provider changes only its Clawdi label`, async ({ page }) => {
		const provider = {
			id: "rename-row",
			provider_id: "work-account",
			label: "Work account",
			type: "openai",
			configuration_mode: "native",
			native_provider: kind === "oauth" ? "openai-codex" : "openai",
			native_variant: null,
			base_url: "https://api.openai.com/v1",
			api_mode: "openai_responses",
			runtime_env_name: kind === "oauth" ? null : "OPENAI_API_KEY",
			managed_by: "user",
			scope: "account",
			models: null,
			auth:
				kind === "oauth"
					? { type: "agent_profile", tool: "codex", profile: "default" }
					: { type: "api_key", source: "managed" },
			usable: true,
		};
		const patches: unknown[] = [];
		await page.route("**/v1/ai-providers", (route) =>
			route.fulfill({ json: { providers: [provider] } }),
		);
		await page.route("**/v1/ai-providers/work-account", async (route) => {
			const body = route.request().postDataJSON();
			patches.push(body);
			await route.fulfill({ json: { ...provider, label: body.label } });
		});
		await page.goto("/ai-providers");
		await page.getByRole("button", { name: "Edit Work account", exact: true }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByLabel("Name", { exact: true }).fill("Personal account");
		await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
		await expect(dialog).toBeHidden();
		expect(patches).toEqual([{ label: "Personal account" }]);
	});
}

test("editing and rotating an agent-owned connection sends one atomic patch without models or env changes", async ({
	page,
}) => {
	const errors = collectBrowserErrors(page);
	const provider = {
		id: "connection-row",
		provider_id: "saved-connection",
		label: "Saved connection",
		type: "custom_openai_compatible",
		configuration_mode: "custom",
		base_url: "https://custom.example/v1",
		api_mode: "openai_responses",
		runtime_env_name: "SAVED_CONNECTION_KEY",
		managed_by: "user",
		scope: "account",
		models: [{ id: "historic-model" }],
		auth: { type: "api_key", source: "managed" },
		usable: true,
		readiness: {
			deployable: true,
			credential_material: "available",
			runtime_compatibility: { openclaw: true, hermes: true, codex: false },
		},
	};
	const patches: unknown[] = [];
	const unexpected: string[] = [];
	page.on("request", (request) => {
		if (/\/v1\/ai-providers\/(?:accept|.*test)(?:\?|$)/.test(request.url()))
			unexpected.push(request.url());
	});
	await page.route("**/v1/ai-providers", (route) =>
		route.fulfill({ json: { providers: [provider] } }),
	);
	await page.route("**/v1/ai-providers/saved-connection", async (route) => {
		const body = route.request().postDataJSON();
		patches.push(body);
		await route.fulfill({ json: { ...provider, label: body.label, base_url: body.base_url } });
	});
	await page.goto("/ai-providers");
	await page.getByRole("button", { name: "Edit Saved connection", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toHaveAccessibleName("Edit Saved connection");
	await expect(dialog.getByLabel("Model catalog")).toHaveCount(0);
	await expect(dialog.getByRole("button", { name: "Test connection", exact: true })).toHaveCount(0);
	await expect(dialog.getByLabel("Agent environment variable")).toHaveCount(0);
	await dialog.getByLabel("Name", { exact: true }).fill("Updated connection");
	await dialog.getByLabel("Endpoint").fill("https://updated.example/v1");
	await dialog.getByLabel("API key", { exact: true }).fill("synthetic-rotated-key");
	await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(patches).toEqual([
		{
			label: "Updated connection",
			base_url: "https://updated.example/v1",
			credential: { type: "api_key", value: "synthetic-rotated-key" },
		},
	]);
	expect(unexpected).toEqual([]);
	expect(errors).toEqual([]);
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
	await page.getByRole("button", { name: "OpenAI API", exact: true }).click();
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
	});
	expect((await acceptedRequest).postDataJSON().provider).not.toHaveProperty("models");

	await expect(page.getByRole("dialog", { name: /Set up OpenAI/ })).toBeHidden();
	// The provider icon carries an SVG <title>OpenAI</title> (always hidden) —
	// assert on a visible text node instead.
	await expect(
		page.getByText("OpenAI", { exact: true }).locator("visible=true").first(),
	).toBeVisible();
	expect(inferenceRequests).toEqual([]);
	expect(errors, `providers flow: ${errors.join(" | ")}`).toEqual([]);
});

test("editing a catalog connection preserves its models and configuration mode", async ({
	page,
}) => {
	const models = [{ id: "existing-model", capabilities: { tools: true } }];
	const capabilities = { tools: true };
	await page.route("**/v1/ai-providers", (route) =>
		route.fulfill({
			json: {
				providers: [
					{
						id: "legacy-row",
						provider_id: "legacy-openai",
						label: "Existing OpenAI",
						type: "openai",
						configuration_mode: "catalog",
						base_url: "https://api.openai.com/v1",
						api_mode: "openai_responses",
						runtime_env_name: "OPENAI_API_KEY",
						managed_by: "user",
						scope: "account",
						models,
						capabilities,
						auth: { type: "api_key", source: "managed" },
						usable: true,
						readiness: {
							deployable: true,
							credential_material: "available",
							runtime_compatibility: { openclaw: true, hermes: true, codex: true },
						},
					},
				],
			},
		}),
	);
	await page.goto("/ai-providers");
	await page.getByRole("button", { name: "Edit Existing OpenAI", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "Edit Existing OpenAI" });
	await expect(dialog.getByLabel("Model catalog")).toHaveCount(0);
	await dialog.getByLabel("API key", { exact: true }).fill("replacement-fixture-key");
	const request = page.waitForRequest(
		(item) => item.url().endsWith("/ai-providers/accept") && item.method() === "POST",
	);
	await dialog.getByRole("button", { name: "Save settings", exact: true }).click();
	expect((await request).postDataJSON()).toMatchObject({
		replace: true,
		provider: { configuration_mode: "catalog", native_provider: null, models, capabilities },
	});
	await expect(dialog).toBeHidden();
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

test("popular BYOK providers support credential-only product setup", async ({ page }, testInfo) => {
	const errors = collectBrowserErrors(page);
	const inferenceRequests: string[] = [];
	page.on("request", (request) => {
		if (/\/ai-providers\/(?:[^/]+\/)?test(?:\?|$)/.test(request.url()))
			inferenceRequests.push(request.url());
	});
	await page.setViewportSize({ width: 1000, height: 1000 });
	await page.goto("/ai-providers");
	await page.getByRole("button", { name: "Add provider", exact: true }).first().click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("button", { name: "Kimi", exact: true })).toHaveCount(1);
	await expect(
		dialog.getByRole("button", { name: "Qwen (Model Studio)", exact: true }),
	).toHaveCount(1);
	const bounds = await dialog.boundingBox();
	expect(bounds?.height).toBeLessThanOrEqual(576);
	await page.screenshot({ path: testInfo.outputPath("provider-brands.png") });
	await page.setViewportSize({ width: 390, height: 844 });
	const mobileBounds = await dialog.boundingBox();
	expect(mobileBounds?.height).toBeLessThanOrEqual(576);
	expect(mobileBounds?.width).toBeLessThanOrEqual(390);
	await expect(dialog.getByTestId("provider-dialog-body")).toHaveJSProperty("scrollLeft", 0);
	await page.screenshot({ path: testInfo.outputPath("provider-mobile.png") });
	await page.setViewportSize({ width: 1000, height: 1000 });
	await dialog.getByRole("button", { name: "Kimi", exact: true }).click();
	await expect(dialog.getByRole("button", { name: "Kimi Code", exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "API · Global", exact: true })).toBeVisible();
	await page.screenshot({ path: testInfo.outputPath("provider-variants.png") });
	await dialog.getByRole("button", { name: "Back to providers", exact: true }).click();
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
		await dialog
			.getByRole("button", {
				name: choice.name,
				exact: true,
			})
			.click();
		if (choice.product)
			await dialog.getByRole("button", { name: choice.product, exact: true }).click();
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

		await expect(dialog.getByLabel("Model catalog")).toHaveCount(0);
		await expect(dialog.getByLabel("Endpoint")).toHaveCount(0);
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
		});
		await expect(dialog).toBeHidden();
		if (choice.variant !== "tokenplan")
			await page.getByRole("button", { name: "Add provider", exact: true }).first().click();
	}
	expect(inferenceRequests).toEqual([]);
	expect(errors).toEqual([]);
});
