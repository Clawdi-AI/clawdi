import { expect, type Route, test } from "@playwright/test";

const token = `v2_${"a".repeat(43)}`;
const context = {
	id: "11111111-1111-4111-8111-111111111111",
	vault_id: "22222222-2222-4222-8222-222222222222",
	project_id: "33333333-3333-4333-8333-333333333333",
	vault_name: "Production API",
	project_name: "Agent workspace",
	slug: "production-api",
	section: "",
	fields: ["API_KEY", "API_SECRET"],
	update_fields: [],
	status: "pending",
	expires_at: "2099-01-01T00:00:00Z",
	supplied_at: null,
	references: {},
	content_version: 1,
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

for (const status of ["missing", "invalid", "error"]) {
	test(`${status} request offers no agent message`, async ({ page }) => {
		await page.route("**/v1/vault/requests/inspect", (route) =>
			route.fulfill({ status: 500, json: { detail: "Unavailable" } }),
		);
		await page.goto(
			status === "missing"
				? "/vault-request"
				: `/vault-request#${status === "invalid" ? "a".repeat(43) : token}`,
		);
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

for (const viewport of [
	{ width: 1280, height: 900 },
	{ width: 390, height: 844 },
]) {
	test(`dotenv preview and user-added fields at ${viewport.width}px`, async ({
		page,
	}, testInfo) => {
		await page.setViewportSize(viewport);
		let submissions = 0;
		await page.route("**/v1/vault/requests/**", async (route) => {
			const body = route.request().postDataJSON();
			if (route.request().url().endsWith("/supply")) {
				submissions++;
				expect(body.fields).toEqual({
					API_KEY: "synthetic-import",
					API_SECRET: "synthetic-secret",
					"api.key": "${LITERAL}",
					"api-key": "synthetic-new",
				});
				return route.fulfill({
					json: {
						...context,
						fields: Object.keys(body.fields),
						extra_fields: ["api.key", "api-key"],
						status: "supplied",
					},
				});
			}
			return route.fulfill({
				json: { ...context, update_fields: body.fields?.includes("api.key") ? ["api.key"] : [] },
			});
		});
		await page.goto(`/vault-request#${token}`);
		await page.getByLabel("API_KEY", { exact: true }).fill("synthetic-draft");
		await page.getByLabel("API_SECRET", { exact: true }).fill("synthetic-secret");
		await page.getByRole("button", { name: "Add field", exact: true }).click();
		await page.getByRole("textbox", { name: "Field name", exact: true }).fill("temporary");
		await page.getByRole("textbox", { name: "Field name", exact: true }).fill("renamed");
		await page.getByRole("button", { name: "Remove renamed" }).click();
		await expect(page.getByRole("textbox", { name: "Field name", exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "Import .env", exact: true }).click();
		const dotenv = "API_KEY=synthetic-import\napi.key=${LITERAL}\napi-key=synthetic-new";
		if (viewport.width < 500) {
			await page
				.getByLabel("Choose .env file")
				.setInputFiles({ name: ".env", mimeType: "text/plain", buffer: Buffer.from(dotenv) });
		} else {
			await page.getByLabel("Dotenv text").fill(dotenv);
		}
		await expect(page.getByLabel("Dotenv text")).toHaveValue(dotenv);
		await expect(page.getByRole("button", { name: "Save secrets", exact: true })).toBeDisabled();
		await page.getByRole("button", { name: "Preview import", exact: true }).click();
		await expect(page.getByText("Replace entered value", { exact: false })).toBeVisible();
		await expect(
			page.getByText("Update existing Vault value on save", { exact: false }),
		).toBeVisible();
		await expect(page.getByLabel("API_KEY", { exact: true })).toHaveValue("synthetic-draft");
		await page.screenshot({
			path: testInfo.outputPath(`preview-${viewport.width}.png`),
			fullPage: true,
		});
		expect(submissions).toBe(0);
		await page.getByRole("button", { name: "Apply import", exact: true }).click();
		await expect(page.getByLabel("API_KEY", { exact: true })).toHaveValue("synthetic-import");
		await expect(page.getByRole("textbox", { name: "Field name", exact: true })).toHaveCount(2);
		await expect(page.getByText("Update", { exact: true })).toHaveCount(1);
		await page.screenshot({
			path: testInfo.outputPath(`fields-${viewport.width}.png`),
			fullPage: true,
		});
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await page.getByRole("button", { name: "Save secrets", exact: true }).click();
		await expect(page.getByRole("status")).toContainText("Your secrets are saved");
		expect(submissions).toBe(1);
		await page.screenshot({
			path: testInfo.outputPath(`saved-${viewport.width}.png`),
			fullPage: true,
		});
	});
}

test("an import of only requested names requires Apply and keeps a usable Save", async ({
	page,
}) => {
	await page.route("**/v1/vault/requests/inspect", (route) => route.fulfill({ json: context }));
	await page.goto(`/vault-request#${token}`);
	await page.getByLabel("API_KEY", { exact: true }).fill("synthetic-original");
	await page.getByRole("button", { name: "Import .env", exact: true }).click();
	await page.getByLabel("Dotenv text").fill("API_KEY=synthetic-new\nAPI_KEY=duplicate");
	await page.getByRole("button", { name: "Preview import", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("duplicate");
	await expect(page.getByRole("button", { name: "Retry check", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Apply import", exact: true })).toHaveCount(0);
	await expect(page.getByLabel("API_KEY", { exact: true })).toHaveValue("synthetic-original");
	await page.getByLabel("Dotenv text").fill("API_KEY=synthetic-new");
	await page.getByRole("button", { name: "Preview import", exact: true }).click();
	await page.getByRole("button", { name: "Cancel import", exact: true }).click();
	await expect(page.getByLabel("API_KEY", { exact: true })).toHaveValue("synthetic-original");
	await page.getByRole("button", { name: "Import .env", exact: true }).click();
	await page.getByLabel("Dotenv text").fill("API_KEY=synthetic-new");
	await page.getByRole("button", { name: "Preview import", exact: true }).click();
	await page.getByRole("button", { name: "Apply import", exact: true }).click();
	await expect(page.getByLabel("API_KEY", { exact: true })).toHaveValue("synthetic-new");
	await expect(page.getByRole("button", { name: "Save secrets", exact: true })).toBeEnabled();
});

test("selection checks debounce names and ignore an obsolete response", async ({ page }) => {
	await page.clock.install();
	const checkedExtras: string[] = [];
	let obsolete: Route | undefined;
	await page.route("**/v1/vault/requests/inspect", (route) => {
		const fields: string[] | undefined = route.request().postDataJSON().fields;
		const extra = fields?.find((name) => !context.fields.includes(name));
		if (extra) checkedExtras.push(extra);
		if (extra === "OLD") {
			obsolete = route;
			return;
		}
		return route.fulfill({ json: { ...context, update_fields: extra === "API" ? [extra] : [] } });
	});
	await page.goto(`/vault-request#${token}`);
	const save = page.getByRole("button", { name: "Save secrets", exact: true });
	await expect(save).toBeEnabled();
	await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
	await page.getByRole("button", { name: "Add field", exact: true }).click();
	const name = page.getByRole("textbox", { name: "Field name", exact: true });
	for (const value of ["A", "AP", "API"]) {
		await name.fill(value);
		await expect(save).toBeDisabled();
		await page.clock.runFor(100);
		expect(checkedExtras).toEqual([]);
	}
	await page.clock.runFor(200);
	await expect(save).toBeEnabled();
	expect(checkedExtras).toEqual(["API"]);
	await expect(page.getByText("Update", { exact: true })).toHaveCount(1);
	await name.fill("OLD");
	await expect(save).toBeDisabled();
	await expect(page.getByText("Update", { exact: true })).toHaveCount(0);
	await page.clock.runFor(300);
	await expect.poll(() => obsolete !== undefined).toBe(true);
	await name.fill("NEW");
	if (!obsolete) throw new Error("Expected the older selection request");
	await obsolete.fulfill({ json: { ...context, update_fields: ["API_KEY"] } });
	await page.clock.runFor(100);
	await expect(save).toBeDisabled();
	await expect(page.getByText("Update", { exact: true })).toHaveCount(0);
	await page.clock.runFor(200);
	await expect(save).toBeEnabled();
	expect(checkedExtras).toEqual(["API", "OLD", "NEW"]);
	await expect(page.getByText("Update", { exact: true })).toHaveCount(0);
});

test("selection failures distinguish retry, invalid names, conflict and terminal expiry", async ({
	page,
}) => {
	let failure: number | "network" | undefined;
	await page.route("**/v1/vault/requests/inspect", (route) => {
		if (!route.request().postDataJSON().fields || failure === undefined)
			return route.fulfill({ json: context });
		if (failure === "network") return route.abort("failed");
		return route.fulfill({
			status: failure,
			json: { detail: "Internal diagnostic must not be displayed" },
		});
	});
	await page.goto(`/vault-request#${token}`);
	const save = page.getByRole("button", { name: "Save secrets", exact: true });
	const retry = page.getByRole("button", { name: "Retry check", exact: true });
	await expect(save).toBeEnabled();
	await page.getByLabel("API_KEY", { exact: true }).fill("synthetic-draft");
	failure = 500;
	await page.getByRole("button", { name: "Add field", exact: true }).click();
	const name = page.getByRole("textbox", { name: "Field name", exact: true });
	await name.fill("EXTRA");
	await expect(page.getByRole("alert")).toContainText("server is unavailable");
	await expect(save).toBeDisabled();
	await expect(retry).toBeVisible();
	failure = "network";
	await retry.click();
	await expect(page.getByRole("alert")).toContainText("Could not connect");
	await expect(page.getByLabel("API_KEY", { exact: true })).toHaveValue("synthetic-draft");
	failure = 422;
	await retry.click();
	await expect(page.getByRole("alert")).toContainText("field names are invalid");
	await expect(retry).toHaveCount(0);
	failure = 409;
	await name.fill("RESERVED");
	await expect(page.getByRole("alert")).toContainText("changed or are reserved");
	await expect(retry).toHaveCount(0);
	await expect(save).toBeDisabled();
	await expect(page.getByLabel("API_KEY", { exact: true })).toHaveValue("synthetic-draft");
	failure = 410;
	await name.fill("EXPIRED");
	await expect(page.getByRole("alert")).toContainText("link has expired");
	await expect(page.getByRole("textbox")).toHaveCount(0);
	await expect(save).toHaveCount(0);
	await expect(retry).toHaveCount(0);
});

test("import preview retries server failure and clears the form on terminal expiry", async ({
	page,
}) => {
	let failure = 500;
	await page.route("**/v1/vault/requests/inspect", (route) => {
		if (route.request().postDataJSON().fields?.includes("imported")) {
			return route.fulfill({ status: failure, json: { detail: "Unavailable" } });
		}
		return route.fulfill({ json: context });
	});
	await page.goto(`/vault-request#${token}`);
	await page.getByLabel("API_KEY", { exact: true }).fill("synthetic-draft");
	await page.getByRole("button", { name: "Import .env", exact: true }).click();
	await page.getByLabel("Dotenv text").fill("imported=synthetic-value");
	await page.getByRole("button", { name: "Preview import", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("server is unavailable");
	await expect(page.getByRole("button", { name: "Retry check", exact: true })).toHaveCount(0);
	await expect(page.getByLabel("Dotenv text")).toHaveValue("imported=synthetic-value");
	failure = 410;
	await page.getByRole("button", { name: "Preview import", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("link has expired");
	await expect(page.getByRole("textbox")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Save secrets", exact: true })).toHaveCount(0);
});
