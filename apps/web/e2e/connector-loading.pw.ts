import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function app(name: string) {
	return {
		name,
		display_name: name.toUpperCase(),
		logo: name === "alpha" ? "https://logos.example.test/alpha.png" : "",
		description: `${name} connection`,
		auth_type: "oauth2",
		connect_disabled: false,
		connect_disabled_reason: null,
	};
}

for (const width of [1440, 375]) {
	test(`connector loading keeps stable slots at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 1000 });
		const catalog = deferred();
		const metadata = deferred();
		const metadataStarted = deferred();
		const batches: string[][] = [];
		const logo = deferred();
		const details: string[] = [];
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.route("https://logos.example.test/**", async (route) => {
			await logo.promise;
			await route.fulfill({
				contentType: "image/png",
				body: readFileSync(new URL("../public/favicon-32x32.png", import.meta.url)),
			});
		});
		await page.route("**/v1/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			let body: unknown = {};
			if (path === "/v1/connectors") {
				body = ["alpha", "beta", "gamma", "retired", "alpha"].map((name, index) => ({
					id: `connection-${index}`,
					app_name: name,
					status: "ACTIVE",
					created_at: "2026-09-07T00:00:00Z",
				}));
			} else if (path === "/v1/connectors/available") {
				await catalog.promise;
				body = { items: [app("alpha")], total: 1, page: 1, page_size: 24 };
			} else if (path === "/v1/connectors/metadata:batchRead") {
				batches.push(route.request().postDataJSON().names);
				metadataStarted.resolve();
				await metadata.promise;
				body = {
					items: ["alpha", "beta", "gamma"].map((name) => {
						const value = app(name);
						return {
							name,
							display_name: value.display_name,
							logo: value.logo,
							description: value.description,
						};
					}),
					missing: ["retired"],
				};
			} else if (path.startsWith("/v1/connectors/available/")) {
				const name = path.split("/").at(-1) ?? "";
				details.push(name);
				body = app(name);
			} else if (["/v1/agents", "/v1/projects", "/v1/vault", "/v1/auth/keys"].includes(path)) {
				body = [];
			} else if (path.endsWith("/tools")) {
				body = [];
			} else if (["/v1/sessions", "/v1/skills", "/v1/memories"].includes(path)) {
				body = { items: [], total: 0, page: 1, page_size: 24 };
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify(body),
			});
		});
		try {
			await page.goto("/connectors");
			await expect(page.getByText("5 active", { exact: true })).toBeVisible();
			await metadataStarted.promise;
			metadata.resolve();
			const rail = page
				.locator("section")
				.filter({ has: page.getByText("Ready to use", { exact: true }) });
			const gamma = rail.getByRole("link", { name: "GAMMA", exact: true });
			await expect(gamma).toBeVisible();
			await expect(rail.getByText("4 apps", { exact: true })).toBeVisible();
			await expect(rail.getByRole("link", { name: "retired", exact: true })).toBeVisible();
			expect(batches).toEqual([["alpha", "beta", "gamma", "retired"]]);
			const before = await gamma.boundingBox();
			expect(before).not.toBeNull();
			const alpha = rail.getByRole("link", { name: "ALPHA", exact: true }).locator("..");
			await expect(alpha.getByText("A", { exact: true })).toBeVisible();
			catalog.resolve();
			await expect(page.getByText("1 available").first()).toBeVisible();
			await page.screenshot({
				path: testInfo.outputPath("connectors-loading.png"),
				fullPage: true,
			});
			await expect(rail.getByRole("link", { name: "BETA", exact: true })).toBeVisible();
			expect(await gamma.boundingBox()).toEqual(before);
			expect(details).toEqual([]);
			logo.resolve();
			await expect(alpha.locator("img")).toHaveCSS("opacity", "1");
			await expect(alpha.getByText("A", { exact: true })).toHaveCSS("visibility", "hidden");
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);
			expect(errors).toEqual([]);
			await page.screenshot({ path: testInfo.outputPath("connectors-loaded.png"), fullPage: true });
			await rail.getByRole("link", { name: "ALPHA", exact: true }).click();
			await expect.poll(() => details).toEqual(["alpha"]);
			expect(errors).toEqual([]);
		} finally {
			catalog.resolve();
			metadata.resolve();
			logo.resolve();
		}
	});
}
