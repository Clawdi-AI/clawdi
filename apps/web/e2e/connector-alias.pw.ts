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

test("catalog OAuth sends optional alias and preserves popup handoff", async ({
	page,
	context,
}) => {
	await stub(page);
	const requests: unknown[] = [];
	await page.route("**/v1/connectors/gmail/connect", async (route) => {
		requests.push(route.request().postDataJSON());
		await route.fulfill({ json: { connect_url: "https://authorize.example.test/" } });
	});
	await context.route("https://authorize.example.test/", (route) =>
		route.fulfill({ body: "Authorize account" }),
	);
	await page.goto("/connectors");
	await page.getByRole("button", { name: "Connect", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Account alias (optional)").fill("work-gmail");
	const popupPromise = page.waitForEvent("popup");
	await dialog.getByRole("button", { name: "Continue", exact: true }).click();
	const popup = await popupPromise;
	await expect(popup).toHaveURL("https://authorize.example.test/");
	expect(requests).toEqual([
		{ alias: "work-gmail", redirect_url: "http://127.0.0.1:3200/connectors/gmail" },
	]);
	await popup.close();
	await expect(dialog).toBeHidden();
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
	await dialog.getByLabel("Account alias (optional)").fill("work-gmail");
	await dialog.getByRole("button", { name: "Connect", exact: true }).click();
	await expect(dialog.getByRole("alert")).toContainText("The account couldn’t be connected");
	await expect(page.getByText("secret-upstream-error")).toHaveCount(0);
	await dialog.getByLabel("Account alias (optional)").fill("");
	await dialog.getByLabel("Account alias (optional)").press("Enter");
	await expect(dialog).toBeHidden();
	expect(requests).toEqual([
		{ credentials: { api_key: "test-key" }, alias: "work-gmail" },
		{ credentials: { api_key: "test-key" } },
	]);
});

for (const agentScope of [false, true]) {
	test(`account alias edit, retry and clear retain identity (${agentScope ? "agent" : "library"})`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 375, height: 900 });
		await stub(page);
		const accounts = [
			{
				id: "ca_work",
				app_name: "gmail",
				alias: "work",
				account_display: "work@example.test",
				status: "ACTIVE",
			},
			{
				id: "ca_personal",
				app_name: "gmail",
				alias: null,
				account_display: "personal@example.test",
				status: "ACTIVE",
			},
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
			accounts[0].account_display = body.alias || "work@example.test";
			await route.fulfill({ json: accounts[0] });
		});
		await page.goto(`${agentScope ? `/agents/${agent.id}` : ""}/connectors/gmail`);
		await expect(page.getByText("work@example.test", { exact: true })).toBeVisible();
		await expect(page.getByText("personal@example.test", { exact: true })).toBeVisible();
		if (agentScope) await expect(page.getByText("Shared across all agents")).toBeVisible();
		await page.getByRole("button", { name: "Edit alias", exact: true }).first().click();
		const dialog = page.getByRole("dialog");
		await dialog.getByLabel("Account alias (optional)").fill("office");
		try {
			await dialog.getByRole("button", { name: "Save", exact: true }).click();
			await expect.poll(() => updates.length).toBe(1);
			await expect(dialog.getByRole("button", { name: /Save/ })).toBeDisabled();
			await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
			await page.keyboard.press("Escape");
			await expect(dialog).toBeVisible();
		} finally {
			release();
		}
		await expect(dialog.getByRole("alert")).toContainText("Couldn't save alias");
		await expect(page.getByText("secret-upstream-error")).toHaveCount(0);
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByText("office", { exact: true })).toBeVisible();
		await expect(page.getByText("Account ca_work", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Edit alias", exact: true }).first().click();
		await dialog.getByLabel("Account alias (optional)").fill("");
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByText("office", { exact: true })).toHaveCount(0);
		await expect(page.getByText("work@example.test", { exact: true })).toBeVisible();
		expect(updates).toEqual([{ alias: "office" }, { alias: "office" }, { alias: "" }]);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
	});
}
