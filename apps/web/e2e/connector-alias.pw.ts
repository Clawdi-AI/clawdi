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

for (const agentScope of [false, true]) {
	test(`inactive accounts stay manageable and reconnect in place (${agentScope ? "agent" : "library"})`, async ({
		page,
		context,
	}) => {
		await page.setViewportSize({ width: 375, height: 900 });
		await stub(page);
		let accounts = [
			{
				id: "ca_work",
				app_name: "gmail",
				alias: "work",
				status: "EXPIRED",
				is_disabled: false,
				reconnect_strategy: "oauth",
			},
			{
				id: "ca_disabled",
				app_name: "gmail",
				alias: "disabled",
				status: "ACTIVE",
				is_disabled: true,
				reconnect_strategy: "enable",
			},
			{
				id: "ca_failed",
				app_name: "gmail",
				alias: "failed",
				status: "FAILED",
				is_disabled: false,
				reconnect_strategy: "unsupported",
			},
			{
				id: "ca_inactive",
				app_name: "gmail",
				alias: "inactive",
				status: "INACTIVE",
				is_disabled: false,
				reconnect_strategy: "enable",
			},
		];
		await page.route("**/v1/connectors", (route) => route.fulfill({ json: accounts }));
		const requests: string[] = [];
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/v1/connectors/*/reconnect", async (route) => {
			const id = new URL(route.request().url()).pathname.split("/").at(-2);
			requests.push(id ?? "");
			if (requests.length === 1)
				return route.fulfill({ status: 502, json: { detail: "secret-upstream-error" } });
			if (requests.length === 2) await pending;
			if (id === "ca_disabled") {
				accounts = accounts.map((account) =>
					account.id === id ? { ...account, is_disabled: false } : account,
				);
				return route.fulfill({ json: { id, status: "ACTIVE", connect_url: null } });
			}
			await route.fulfill({
				json: { id, status: "INITIATED", connect_url: "https://authorize.example.test/" },
			});
		});
		await context.route("https://authorize.example.test/", (route) =>
			route.fulfill({ body: "Authorize account" }),
		);
		const prefix = agentScope ? `/agents/${agent.id}` : "";
		await page.goto(`${prefix}/connectors`);
		const rail = page
			.locator("section")
			.filter({ has: page.getByText("Your connections", { exact: true }) })
			.last();
		await expect(rail.getByText("Needs attention")).toBeVisible();
		await expect(page.getByLabel("Connected", { exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Connect", exact: true })).toHaveCount(0);
		await rail.getByRole("link", { name: "Gmail", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`${prefix}/connectors/gmail$`));
		await expect(page.getByText("0 active · 4 total", { exact: true })).toBeVisible();
		for (const status of ["Expired", "Disabled", "Connection failed", "Inactive"]) {
			await expect(page.getByText(status, { exact: true })).toBeVisible();
		}
		await expect(page.getByText("Reconnect unavailable", { exact: true })).toBeVisible();
		const work = page.getByText("work", { exact: true }).locator("../..");
		const reconnect = work.getByRole("button", { name: "Reconnect", exact: true });
		await page.evaluate(() => {
			const open = window.open;
			window.open = () => {
				window.open = open;
				return null;
			};
		});
		await reconnect.click();
		await expect(work.getByRole("alert")).toContainText("Popup blocked");
		expect(requests).toHaveLength(0);
		const firstPopup = page.waitForEvent("popup");
		await reconnect.click();
		const failedPopup = await firstPopup;
		await expect(work.getByRole("alert")).toContainText("Couldn't reconnect");
		await expect.poll(() => failedPopup.isClosed()).toBe(true);
		await expect(page.getByText("secret-upstream-error")).toHaveCount(0);
		const secondPopup = page.waitForEvent("popup");
		await reconnect.click();
		const cancelledPopup = await secondPopup;
		try {
			await expect.poll(() => requests.length).toBe(2);
			await expect(work.getByRole("button", { name: /Reconnect/ })).toBeDisabled();
			await cancelledPopup.close();
		} finally {
			release();
		}
		await expect(work.getByRole("alert")).toContainText("authorization window was closed");
		const thirdPopup = page.waitForEvent("popup");
		await reconnect.click();
		const popup = await thirdPopup;
		await expect(popup).toHaveURL("https://authorize.example.test/");
		await popup.close();
		await expect(work.getByText("work", { exact: true })).toBeVisible();
		const disabled = page.getByText("disabled", { exact: true }).locator("../..");
		const newPages: Page[] = [];
		page.on("popup", (opened) => newPages.push(opened));
		await disabled.getByRole("button", { name: "Enable account" }).click();
		await expect(page.getByText("1 active · 4 total", { exact: true })).toBeVisible();
		expect(newPages).toHaveLength(0);
		expect(requests).toEqual(["ca_work", "ca_work", "ca_work", "ca_disabled"]);
		await page.route("**/v1/connectors/ca_failed", async (route) => {
			expect(route.request().method()).toBe("DELETE");
			accounts = accounts.filter((account) => account.id !== "ca_failed");
			await route.fulfill({ json: { ok: true } });
		});
		await page
			.getByText("failed", { exact: true })
			.locator("../..")
			.getByRole("button", { name: "Delete", exact: true })
			.click();
		await page
			.getByRole("alertdialog")
			.getByRole("button", { name: "Delete", exact: true })
			.click();
		await expect(page.getByText("failed", { exact: true })).toHaveCount(0);
		await expect(page.getByText("1 active · 3 total", { exact: true })).toBeVisible();
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
	});
}

test("expired credentials use saved account fields and update without replacing its alias", async ({
	page,
}) => {
	await stub(page); // Catalog OAuth metadata must not override the saved account's auth scheme.
	let account = {
		id: "ca_key",
		app_name: "gmail",
		alias: "work-key",
		status: "EXPIRED",
		reconnect_strategy: "credentials",
	};
	await page.route("**/v1/connectors", (route) => route.fulfill({ json: [account] }));
	await page.route("**/v1/connectors/ca_key/reconnect-fields", (route) =>
		route.fulfill({
			json: {
				expected_input_fields: [
					{
						name: "api_key",
						display_name: "API key",
						required: true,
						is_secret: true,
						type: "string",
					},
					{
						name: "region",
						display_name: "Region",
						required: true,
						expected_from_customer: true,
					},
				],
			},
		}),
	);
	const requests: unknown[] = [];
	await page.route("**/v1/connectors/ca_key/credentials", async (route) => {
		expect(route.request().method()).toBe("PATCH");
		requests.push(route.request().postDataJSON());
		if (requests.length === 1)
			return route.fulfill({ status: 400, json: { detail: "secret-upstream-error" } });
		if (requests.length > 2) account = { ...account, status: "ACTIVE" };
		await route.fulfill({ json: account });
	});
	const unexpected: string[] = [];
	page.on("request", (request) => {
		if (
			/\/gmail\/(connect|connect-credentials|auth-fields)$|\/ca_key\/reconnect$/.test(
				new URL(request.url()).pathname,
			)
		)
			unexpected.push(request.url());
	});
	await page.goto("/connectors/gmail");
	await page.getByRole("button", { name: "Update credentials", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText(/work-key/)).toBeVisible();
	await expect(dialog.getByLabel("Account alias (optional)")).toHaveCount(0);
	await dialog.getByLabel("API key").fill("replacement-key");
	await dialog.getByRole("button", { name: "Update credentials", exact: true }).click();
	await expect(dialog.getByRole("alert")).toContainText("credentials couldn’t be updated");
	await expect(page.getByText("secret-upstream-error")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Update credentials", exact: true }).click();
	await expect(dialog.getByRole("status")).toContainText(
		"Credentials saved. This account is not active yet.",
	);
	await expect(dialog.getByLabel("API key")).toHaveValue("");
	await expect(page.getByText("0 active · 1 total", { exact: true })).toBeVisible();
	await dialog.getByLabel("API key").fill("verified-key");
	await dialog.getByRole("button", { name: "Update credentials", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("1 active · 1 total", { exact: true })).toBeVisible();
	await expect(page.getByText("work-key", { exact: true })).toBeVisible();
	expect(requests).toEqual([
		{ credentials: { api_key: "replacement-key" } },
		{ credentials: { api_key: "replacement-key" } },
		{ credentials: { api_key: "verified-key" } },
	]);
	expect(unexpected).toEqual([]);
});

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
				status: "EXPIRED",
				reconnect_strategy: "oauth",
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
		await expect(page.getByText("Expired", { exact: true })).toBeVisible();
		await expect(page.getByText("1 active · 2 total", { exact: true })).toBeVisible();
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
