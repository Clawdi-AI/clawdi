import { expect, type Page, test } from "@playwright/test";
import type {} from "./lifecycle.browser";

for (const phase of ["getToken", "POST", "HEAD"] as const) {
	test(`OpenClaw grant retires ${phase} work when the owner changes`, async ({ page, context }) => {
		test.skip(process.env.VITE_CLAWDI_HOSTED !== "true", "Hosted agent lifecycle");
		const { includedBasicDeployment, mutationDeploymentReadFixture, stubHostedApi } = await import(
			"../hosted-stub-api"
		);
		const endpoint = "https://runtime.example/";
		const deployment = mutationDeploymentReadFixture({
			...includedBasicDeployment,
			config_info: { ...includedBasicDeployment.config_info, runtime: "openclaw" },
			openclaw_control_ui_url: endpoint,
		});
		if (deployment.runtime_ui_endpoint?.runtime !== "openclaw")
			throw new Error("Runtime endpoint missing");
		deployment.runtime_ui_endpoint.browser_session_url = `${endpoint}.well-known/openclaw/browser-session`;
		await stubHostedApi(page, { deployments: [deployment] });
		const held = Promise.withResolvers<void>();
		let holding = false;
		let pending = false;
		let aborted = false;
		let issued = 0;
		const posts: string[] = [];
		page.on("requestfailed", (request) => {
			if (request.url().endsWith("browser-session") && request.method() === phase) aborted = true;
		});
		await page.route(
			"http://127.0.0.1:50021/v2/deployments/*/runtime-ui/credentials",
			async (route) => {
				issued += 1;
				await route.fulfill({
					json: {
						runtime: "openclaw",
						auth_mode: "openclaw_token",
						url: endpoint,
						deployment_resource_version: deployment.resource.metadata.resourceVersion,
						token: "fixture-token",
						handoff_url: `${endpoint}#bootstrapToken=attempt-${issued}&bootstrapProfile=owner`,
					},
				});
			},
		);
		await context.route(`${endpoint}**`, async (route) => {
			const method = route.request().method();
			if (route.request().url().endsWith("browser-session")) {
				if (method === "POST") posts.push(route.request().headers().authorization ?? "missing");
				if (holding && method === phase && !pending) {
					pending = true;
					await held.promise;
				}
				if (route.request().failure()) return;
				await route.fulfill({
					status: 204,
					headers: {
						"Access-Control-Allow-Origin": "http://127.0.0.1:3111",
						"Access-Control-Allow-Credentials": "true",
						"Access-Control-Allow-Headers": "Authorization, If-Match",
						"Access-Control-Allow-Methods": "POST, HEAD, OPTIONS",
					},
					body: "",
				});
			} else {
				// Document-only lifecycle fixture; native auth is verified by the paired gateway suite.
				await route.fulfill({
					contentType: "text/html",
					body: "<!doctype html><p>Lifecycle document</p>",
				});
			}
		});
		try {
			await page.goto("/e2e/auth/");
			await page.evaluate(
				(id) => window.authTest.navigate(`/agents/${id}/console`),
				deployment.agent_id,
			);
			const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
			await expect(iframe).toHaveCount(1);
			expect(posts).toEqual(["Bearer user-a:session-a"]);
			if (phase === "getToken")
				await page.evaluate(() => window.authTest.holdSessionToken("session-a"));
			else holding = true;
			await page.getByRole("button", { name: "Reconnect", exact: true }).click();
			if (phase === "getToken")
				await expect
					.poll(() => page.evaluate(() => window.authTest.heldTokenCalls))
					.toBeGreaterThan(0);
			else await expect.poll(() => pending).toBe(true);
			await expect(iframe).toHaveCount(0);
			await page.evaluate(() =>
				window.authTest.emitSdk({ userId: "user-b", sessionId: "session-b" }),
			);
			await expect(iframe).toHaveAttribute(
				"src",
				`${endpoint}#bootstrapToken=attempt-2&bootstrapProfile=owner`,
			);
			expect(issued).toBe(2);
			held.resolve();
			await page.evaluate(() => window.authTest.releaseSessionToken("session-a"));
			if (phase !== "getToken") await expect.poll(() => aborted).toBe(true);
			await expect(iframe).toHaveAttribute(
				"src",
				`${endpoint}#bootstrapToken=attempt-2&bootstrapProfile=owner`,
			);
			expect(posts.filter((post) => post === "Bearer user-b:session-b")).toHaveLength(1);
			expect(issued).toBe(2);
			expect(
				await page.evaluate(() =>
					Object.keys(localStorage).some(
						(key) =>
							key.startsWith("clawdi.openclaw-native-handoff-loaded.v1.") && key.includes("user-a"),
					),
				),
			).toBe(false);
		} finally {
			held.resolve();
			await page.evaluate(() => window.authTest.releaseSessionToken("session-a"));
		}
	});
}

async function start(page: Page, bootstrap?: string) {
	await page.route("http://127.0.0.1:8000/**", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: route.request().url().endsWith("private-data")
				? route.request().headers().authorization?.replace("Bearer ", "")
				: route.request().url().endsWith("/v1/auth/me")
					? "{}"
					: "[]",
		}),
	);
	await page.goto(bootstrap ? `/e2e/auth/?bootstrap=${bootstrap}` : "/e2e/auth/");
	if (bootstrap) return;
	await page.evaluate(() => window.authTest.navigate("/private/a"));
	await expect(page.locator("[data-private]")).toHaveText("user-a:session-a");
}

for (const bootstrap of ["same-account", "other-account", "signed-out"]) {
	test(`first settled mount revalidates only an admission mismatch: ${bootstrap}`, async ({
		page,
	}) => {
		await start(page, bootstrap);
		if (bootstrap === "signed-out") {
			await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
			await expect(page.locator("[data-private]")).toHaveCount(0);
		} else {
			await expect(page.locator("[data-private]")).toHaveText(
				bootstrap === "same-account" ? "user-a:session-a" : "user-b:session-b",
			);
		}
		expect(await page.evaluate(() => window.authTest.admissions)).toBe(
			bootstrap === "same-account" ? 1 : 2,
		);
		expect(
			await page.evaluate(() =>
				window.authTest.commits.filter((commit) => commit.data && commit.data !== commit.identity),
			),
		).toEqual([]);
	});
}

test("same identity keeps cache, draft and iframe document across navigation and history", async ({
	page,
}) => {
	await start(page);
	const frame = page.frameLocator("iframe");
	await frame.getByRole("textbox").fill("retained-runtime-draft");
	await page.getByRole("link", { name: "B", exact: true }).click();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Destination B");
	await page.goBack();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Destination A");
	await page.goForward();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Destination B");
	await expect(frame.getByRole("textbox")).toHaveValue("retained-runtime-draft");
	await page.getByRole("textbox", { name: "Draft", exact: true }).fill("unsaved");
	await page.getByRole("link", { name: "A", exact: true }).click();
	await expect(page.getByRole("alertdialog")).toBeVisible();
	await page.getByRole("button", { name: "Keep editing" }).click();
	await expect(page.getByRole("textbox", { name: "Draft", exact: true })).toHaveValue("unsaved");
});

test("public routes stay available while loading and signed-out client navigation stays protected", async ({
	page,
}) => {
	await page.goto("/e2e/auth/");
	await page.evaluate(() => window.authTest.emitSdk({ isLoaded: false }));
	await page.evaluate(() => window.authTest.navigate("/private/a"));
	await expect(page.locator("[data-private]")).toHaveCount(0);
	await expect(page.locator("iframe")).toHaveCount(0);
	await page.evaluate(() => window.authTest.navigate("/public"));
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Public content");
	await page.evaluate(() =>
		window.authTest.emitSdk({ isLoaded: true, userId: null, sessionId: null }),
	);
	await page.evaluate(() => window.authTest.navigate("/private/a"));
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
	await expect(page.locator("[data-private]")).toHaveCount(0);
});

for (const update of [{ userId: "user-b", sessionId: "session-b" }, { sessionId: "session-b" }]) {
	test(`identity switch isolates cached destinations and retires preloads: ${JSON.stringify(update)}`, async ({
		page,
	}) => {
		await start(page);
		await page.evaluate(() => window.authTest.navigate("/private/b"));
		await page.evaluate(() => window.authTest.navigate("/private/a"));
		await page.evaluate(() => window.authTest.holdPreload());
		await page.frameLocator("iframe").getByRole("textbox").fill("old-session");
		await page.evaluate((update) => window.authTest.emitSdk(update), update);
		await expect(page.locator("[data-private]")).toHaveText(
			`${update.userId ?? "user-a"}:session-b`,
		);
		await expect(page.frameLocator("iframe").getByRole("textbox")).toHaveValue("");
		expect(await page.evaluate(() => window.authTest.abortedPreload)).toBe(true);
		await page.evaluate(() => window.authTest.releasePreload());
		const commits = await page.evaluate(() => window.authTest.commits);
		expect(commits.filter((commit) => commit.data && commit.data !== commit.identity)).toEqual([]);
		await page.goBack();
		await expect(page.locator("[data-private]")).toHaveText(
			`${update.userId ?? "user-a"}:session-b`,
		);
	});
}

for (const update of [{ userId: null, sessionId: null }, { pending: true }]) {
	test(`logout/session-task emissions remove protected UI and cached history: ${JSON.stringify(update)}`, async ({
		page,
	}) => {
		await start(page);
		await page.evaluate(() => window.authTest.navigate("/private/b"));
		await page.evaluate((update) => window.authTest.emitSdk(update), update);
		await expect(page.locator("iframe")).toHaveCount(0);
		await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
		await page.goBack();
		await expect(page.locator("[data-private]")).toHaveCount(0);
		await page.evaluate(() => window.authTest.navigate("/public"));
		await expect(page.getByRole("heading", { level: 1 })).toHaveText("Public content");
	});
}

for (const status of ["degraded", "error"] as const) {
	test(`SDK ${status} blocks stale snapshots without signing out and recovers by event`, async ({
		page,
	}) => {
		await start(page);
		await page.evaluate((status) => window.authTest.emitSdk({ status }), status);
		await expect(page.locator("iframe")).toHaveCount(0);
		expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
		await page.evaluate(() => window.authTest.emitSdk({ status: "ready" }));
		await expect(page.locator("[data-private]")).toHaveText("user-a:session-a");
	});
}

test("native unknown auth removes an admitted session independently of script status", async ({
	page,
}) => {
	await start(page);
	await page.evaluate(() => window.authTest.emitSdk({ isLoaded: false }));
	await expect(page.locator("iframe")).toHaveCount(0);
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
	await page.evaluate(() => window.authTest.emitSdk({ isLoaded: true }));
	await expect(page.locator("[data-private]")).toHaveText("user-a:session-a");
});

test("late old-identity queries cannot publish in the new identity", async ({ page }) => {
	await start(page);
	const late = Promise.withResolvers<void>();
	let seen = false;
	await page.route("**/private-data", async (route) => {
		if (route.request().headers().authorization?.includes("user-a")) {
			seen = true;
			await late.promise;
		}
		await route.fallback();
	});
	await page.evaluate(() => {
		void window.authTest.refetch();
	});
	await expect.poll(() => seen).toBe(true);
	await page.evaluate(() => window.authTest.emitSdk({ userId: "user-b", sessionId: "session-b" }));
	late.resolve();
	await expect(page.locator("[data-private]")).toHaveText("user-b:session-b");
	expect(
		await page.evaluate(() =>
			window.authTest.commits.filter((c) => c.data && c.data !== c.identity),
		),
	).toEqual([]);
});

test("401 account admission is denied; resource 403 and refresh/network failures do not hard-logout", async ({
	page,
}) => {
	await start(page);
	await page.route("**/private-data", (route) => route.fulfill({ status: 403, body: "Forbidden" }));
	await page.evaluate(() => window.authTest.refetch());
	await expect(page.getByRole("alert")).toBeVisible();
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
	await expect(page.locator("iframe")).toBeVisible();
	await page.route("**/v1/auth/me", (route) => route.fulfill({ status: 403, body: "Forbidden" }));
	await page.evaluate(() => window.authTest.refetch());
	await expect(page.getByText("Session unavailable.", { exact: true })).toBeVisible();
	await expect(page.locator("iframe")).toHaveCount(0);
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
	await page.unroute("**/v1/auth/me");
	await page.evaluate(() => window.authTest.emitSdk({ tokenFailure: true }));
	await page.evaluate(() => window.authTest.refetch());
	await expect(page.getByText("Session unavailable.", { exact: true })).toBeVisible();
	await expect(page.locator("iframe")).toHaveCount(0);
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
	await page.evaluate(() => window.authTest.emitSdk({ tokenFailure: false }));
	await page.route("**/v1/auth/me", (route) =>
		route.fulfill({
			status: 401,
			contentType: "application/json",
			body: '{"detail":"Invalid session"}',
		}),
	);
	await page.evaluate(() => window.authTest.refetch());
	await expect(page.locator("iframe")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Sign in again", exact: true })).toBeVisible();
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(0);
	await page.getByRole("button", { name: "Sign in again", exact: true }).click();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
	expect(await page.evaluate(() => window.authTest.signOutCalls)).toBe(1);
});

// Simulated SDK resource/cookie events, real production layout and Router.
// The activation checkpoint represents setActive awaiting native SPA navigation.
test("native SPA activation admits the real dashboard frame before private session resources", async ({
	page,
}, info) => {
	const requests: string[] = [];
	await page.route("http://127.0.0.1:50021/**", (route) => {
		requests.push(route.request().headers().authorization ?? "missing");
		return route.fulfill({ status: 503, body: "Unavailable" });
	});
	await page.route("http://127.0.0.1:8000/**", (route) => {
		requests.push(route.request().headers().authorization ?? "missing");
		return route.fulfill({
			contentType: "application/json",
			body: route.request().url().endsWith("private-data")
				? "user-a:session-a"
				: route.request().url().endsWith("/v1/auth/me")
					? "{}"
					: "[]",
		});
	});
	await page.goto("/e2e/auth/");
	await page.evaluate(async () => {
		window.authTest.emitSdk({ userId: null, sessionId: null });
		await window.authTest.navigate("/sign-in");
		void window.authTest.activateSession("/private/a");
	});
	await expect(page.getByTestId("app-sidebar")).toBeVisible();
	await expect(page.locator("header")).toBeVisible();
	await expect(page.getByTestId("dashboard-page-content")).toBeVisible();
	await expect(page.locator("iframe")).toHaveCount(0);
	await expect(page.getByTestId("app-sidebar-user-menu-button")).toBeDisabled();
	await page.keyboard.press("Control+k");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(requests).toEqual([]);
	await info.attach("activation-frame", {
		body: await page.screenshot(),
		contentType: "image/png",
	});
	await page.evaluate(() => window.authTest.releaseActivation());
	await expect(page.locator("[data-private]")).toHaveText("user-a:session-a");
	expect(requests.length).toBeGreaterThan(0);
	expect(requests.every((token) => token === "Bearer user-a:session-a")).toBe(true);
	await page.goBack();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
});

test("null native session token never reaches the API", async ({ page }) => {
	await start(page);
	let requests = 0;
	await page.route("http://127.0.0.1:8000/**", (route) => {
		requests++;
		return route.fallback();
	});
	await page.evaluate(() => window.authTest.emitSdk({ nullToken: true }));
	await page.evaluate(() => window.authTest.refetch());
	await expect(page.getByRole("button", { name: "Sign in again" })).toBeVisible();
	expect(requests).toBe(0);
});

test("retired credentials and late mutation suspension cannot affect the next account", async ({
	page,
}) => {
	await start(page);
	const response = Promise.withResolvers<void>();
	const requested = Promise.withResolvers<void>();
	await page.route("**/v1/me/invitations/fixture/decline", async (route) => {
		expect(route.request().headers().authorization).toBe("Bearer user-a:session-a");
		requested.resolve();
		await response.promise;
		await route.fulfill({
			status: 401,
			contentType: "application/problem+json",
			body: JSON.stringify({
				type: "urn:clawdi:problem:account-suspended",
				status: 401,
				code: "account_suspended",
				detail: "Suspended",
			}),
		});
	});
	try {
		await page.evaluate(() => window.authTest.saveCredentials());
		const mutation = page.evaluate(() => window.authTest.mutate());
		await requested.promise;
		await page.evaluate(() =>
			window.authTest.emitSdk({ userId: "user-b", sessionId: "session-b" }),
		);
		await expect(page.locator("[data-private]")).toHaveText("user-b:session-b");
		expect(await page.evaluate(() => window.authTest.useSavedCredentials())).toBe("retired");
		response.resolve();
		await mutation;
		await expect(page.locator("[data-private]")).toHaveText("user-b:session-b");
		await expect(page.getByText("Account suspended", { exact: true })).toHaveCount(0);
		expect(await page.evaluate(() => window.authTest.oldMutationPublished)).toBe(false);
	} finally {
		response.resolve();
	}
});

test("signed-out public invitations remain anonymous", async ({ page }) => {
	await page.route("**/v1/share/fixture/preview", (route) => {
		expect(route.request().headers().authorization).toBeUndefined();
		return route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({
				project_name: "Shared project",
				owner_display: "Owner",
				owner_handle: "owner",
				skill_count: 1,
				vault_count: 0,
			}),
		});
	});
	await page.goto("/e2e/auth/");
	await page.evaluate(async () => {
		window.authTest.emitSdk({ userId: null, sessionId: null });
		await window.authTest.navigate("/share/fixture");
	});
	await expect(page.getByText("Sign in to accept", { exact: true })).toBeVisible();
	await expect(page.getByText("Shared project", { exact: true })).toBeVisible();
});

test("OpenClaw retires late auth credentials and retains its hidden surface during pending navigation", async ({
	page,
	context,
}) => {
	test.skip(process.env.VITE_CLAWDI_HOSTED !== "true", "Hosted agent lifecycle");
	test.setTimeout(90_000);
	const { includedBasicDeployment, mutationDeploymentReadFixture, stubHostedApi } = await import(
		"../hosted-stub-api"
	);
	const deployment = mutationDeploymentReadFixture({
		...includedBasicDeployment,
		config_info: { ...includedBasicDeployment.config_info, runtime: "openclaw" },
		openclaw_control_ui_url: "https://runtime.example/",
	});
	const requests: string[] = [];
	let documents = 0;
	let release = () => {};
	const oldResponse = new Promise<void>((resolve) => {
		release = resolve;
	});
	await stubHostedApi(page, { deployments: [deployment] });
	await page.route(
		"http://127.0.0.1:50021/v2/deployments/*/runtime-ui/credentials",
		async (route) => {
			requests.push(route.request().headers().authorization ?? "missing");
			const attempt = requests.length;
			if (attempt === 1) await oldResponse;
			await route.fulfill({
				json: {
					runtime: "openclaw",
					auth_mode: "openclaw_token",
					url: "https://runtime.example/",
					deployment_resource_version: deployment.resource.metadata.resourceVersion,
					token: "fixture-token",
					handoff_url: `https://runtime.example/#bootstrapToken=session-${attempt}&bootstrapProfile=owner`,
				},
			});
		},
	);
	await context.route("https://runtime.example/**", (route) => {
		documents += 1;
		return route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><p>Native authentication error</p>",
		});
	});
	try {
		await page.goto("/e2e/auth/");
		await page.evaluate(async (id) => {
			window.authTest.emitSdk({ isLoaded: false });
			await window.authTest.navigate(`/agents/${id}`);
		}, deployment.agent_id);
		const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
		await expect(iframe).toHaveCount(0);
		expect(requests).toEqual([]);
		await page.evaluate(() => window.authTest.emitSdk({ isLoaded: true }));
		await expect.poll(() => requests.length).toBe(1);
		await page.evaluate(() =>
			window.authTest.emitSdk({ userId: "user-b", sessionId: "session-b" }),
		);
		await expect.poll(() => requests.length).toBe(2);
		release();
		await expect(iframe).toHaveAttribute(
			"src",
			"https://runtime.example/#bootstrapToken=session-2&bootstrapProfile=owner",
		);
		await expect.poll(() => documents).toBe(1);
		await expect(iframe).toBeHidden();
		const original = await iframe.elementHandle();
		await page.evaluate((id) => {
			window.authTest.holdConsole();
			void window.authTest.navigate(`/agents/${id}/console`);
		}, deployment.agent_id);
		await expect.poll(() => page.evaluate(() => window.authTest.navigationPending)).toBe(true);
		await expect(iframe).toBeHidden();
		await page.evaluate(() => window.authTest.releasePreload());
		await expect(iframe).toBeVisible();
		await expect(
			page
				.frameLocator('iframe[title="OpenClaw Control UI"]')
				.getByText("Native authentication error"),
		).toBeVisible();
		expect(await original?.evaluate((element) => element.isConnected)).toBe(true);
		expect(documents).toBe(1);
		expect(requests).toEqual(["Bearer user-a:session-a", "Bearer user-b:session-b"]);
		await page.evaluate(() => window.authTest.emitSdk({ sessionId: "session-c" }));
		await expect.poll(() => requests.length).toBe(3);
		await expect.poll(() => documents).toBe(2);
		expect(await original?.evaluate((element) => element.isConnected)).toBe(false);
		await page.evaluate(() => window.authTest.emitSdk({ userId: null, sessionId: null }));
		await expect(iframe).toHaveCount(0);
		await original?.dispose();
	} finally {
		release();
	}
});
