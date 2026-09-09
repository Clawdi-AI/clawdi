import { expect, type Page, test } from "@playwright/test";

const app = {
	name: "gmail",
	display_name: "Gmail",
	logo: "",
	description: "Email",
	auth_type: "oauth2",
	connect_disabled: false,
	connect_disabled_reason: null,
};
const agent = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "Alias Agent",
	display_name: "Alias Agent",
	agent_type: "codex",
	machine_name: "test",
};

async function stub(page: Page, authType = "oauth2") {
	await page.route("**/v1/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		let body: unknown = [];
		if (path === "/v1/connectors/available")
			body = { items: [{ ...app, auth_type: authType }], total: 1, page: 1, page_size: 24 };
		else if (path === "/v1/connectors/metadata:batchRead") body = { items: [app], missing: [] };
		else if (path === "/v1/connectors/available/gmail") body = { ...app, auth_type: authType };
		else if (path === "/v1/connectors/gmail/auth-fields")
			body = {
				expected_input_fields: [
					{
						name: "api_key",
						display_name: "API key",
						required: true,
						is_secret: true,
						type: "string",
					},
				],
			};
		else if (path === "/v1/agents") body = [agent];
		else if (path === `/v1/agents/${agent.id}`) body = agent;
		else if (["/v1/sessions", "/v1/skills", "/v1/memories"].includes(path))
			body = { items: [], total: 0, page: 1, page_size: 24 };
		await route.fulfill({ json: body });
	});
}

test("expired accounts are absent from account rows and counts", async ({ page }) => {
	await stub(page);
	await page.route("**/v1/connectors", (route) =>
		route.fulfill({
			json: [
				{ id: "ca_expired", app_name: "gmail", alias: "old-work", status: "EXPIRED" },
				{ id: "ca_active", app_name: "gmail", alias: "work", status: "ACTIVE" },
			],
		}),
	);
	await page.goto("/connectors/gmail");
	await expect(page.getByText("1 active · 1 total", { exact: true })).toBeVisible();
	await expect(page.getByText("work", { exact: true })).toBeVisible();
	await expect(page.getByText("old-work", { exact: true })).toHaveCount(0);
	await expect(page.getByText(/Inactive accounts/)).toHaveCount(0);
});

test("credentials connect includes alias without leaking failed response details", async ({
	page,
}) => {
	await stub(page, "api_key");
	const requests: unknown[] = [];
	await page.route("**/v1/connectors/gmail/connect-credentials", async (route) => {
		requests.push(route.request().postDataJSON());
		await route.fulfill({
			status: requests.length === 1 ? 400 : 200,
			json: requests.length === 1 ? { detail: "secret-upstream-error" } : {},
		});
	});
	await page.goto("/connectors/gmail");
	await page.getByRole("button", { name: "Connect account" }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("API key").fill("test-key");
	await dialog.getByLabel("Name (optional)").fill("work-gmail");
	await dialog.getByRole("button", { name: "Connect", exact: true }).click();
	await expect(dialog.getByRole("alert")).toContainText("The account couldn’t be connected");
	await expect(page.getByText("secret-upstream-error")).toHaveCount(0);
	await dialog.getByLabel("Name (optional)").fill("");
	await dialog.getByLabel("Name (optional)").press("Enter");
	await expect(dialog).toBeHidden();
	expect(requests).toEqual([
		{ credentials: { api_key: "test-key" }, alias: "work-gmail" },
		{ credentials: { api_key: "test-key" } },
	]);
});

test("Agent account rename, retry and clear retain identity", async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 900 });
	await stub(page);
	const accounts = [
		{
			id: "ca_work",
			app_name: "gmail",
			alias: "work",
			account_display: "work@example.test",
			status: "INACTIVE",
		},
		{
			id: "ca_personal",
			app_name: "gmail",
			alias: "personal@example.test",
			account_display: "personal@example.test",
			status: "ACTIVE",
		},
		{
			id: "ca_named",
			app_name: "gmail",
			alias: "gmail-marvin-phala",
			account_display: "",
			status: "ACTIVE",
		},
		{ id: "ca_123456", app_name: "gmail", alias: null, account_display: "", status: "ACTIVE" },
	];
	await page.route("**/v1/connectors", (route) => route.fulfill({ json: accounts }));
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const updates: unknown[] = [];
	await page.route("**/v1/connectors/ca_work", async (route) => {
		const body = route.request().postDataJSON();
		updates.push(body);
		if (updates.length === 1) {
			await pending;
			return route.fulfill({ status: 409, json: { detail: "secret-upstream-error" } });
		}
		accounts[0] = { ...accounts[0], alias: body.alias || null };
		await route.fulfill({ json: accounts[0] });
	});
	await page.goto(`/agents/${agent.id}/connectors/gmail`);
	await expect(page.getByText("personal@example.test", { exact: true })).toHaveCount(1);
	await expect(page.getByText("personal@example.test", { exact: true })).toBeVisible();
	await expect(page.getByText("gmail-marvin-phala", { exact: true })).toBeVisible();
	await expect(page.getByText("Account ca_named", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Account 123456", { exact: true })).toBeVisible();
	await expect(page.getByText("Inactive", { exact: true })).toBeHidden();
	await page.getByText("Inactive accounts (1)", { exact: true }).click();
	await expect(page.getByText("Inactive", { exact: true })).toBeVisible();
	await expect(page.getByText("3 active · 4 total", { exact: true })).toBeVisible();
	await expect(page.getByText("work@example.test", { exact: true })).toBeVisible();
	await expect(page.getByText("personal@example.test", { exact: true })).toBeVisible();
	await expect(page.getByText("Shared across all agents")).toBeVisible();
	await page.getByRole("button", { name: "Rename", exact: true }).last().click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByRole("heading", { name: "Rename account" })).toBeVisible();
	await dialog.getByLabel("Name (optional)").fill("office");
	try {
		await dialog.getByRole("button", { name: "Rename", exact: true }).click();
		await expect.poll(() => updates.length).toBe(1);
		await expect(dialog.getByRole("button", { name: "Rename" })).toBeDisabled();
		await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
	} finally {
		release();
	}
	await expect(dialog.getByRole("alert")).toContainText("Couldn't rename account");
	await expect(page.getByText("secret-upstream-error")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Rename", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("office", { exact: true })).toBeVisible();
	await expect(page.getByText("work@example.test", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Rename", exact: true }).last().click();
	await dialog.getByLabel("Name (optional)").fill("");
	await dialog.getByRole("button", { name: "Rename", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("office", { exact: true })).toHaveCount(0);
	await expect(page.getByText("work@example.test", { exact: true })).toBeVisible();
	expect(updates).toEqual([{ alias: "office" }, { alias: "office" }, { alias: "" }]);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true,
	);
});
