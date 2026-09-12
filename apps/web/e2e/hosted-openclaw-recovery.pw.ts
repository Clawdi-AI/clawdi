import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
	includedBasicDeployment,
	mutationDeploymentReadFixture,
	stubHostedApi,
} from "./hosted-stub-api";

const endpoint = "https://agent-42-18789.prod.clawdi.test:19444/";
const cookieName = "__Secure-clawdi_openclaw_owner";

test("protected runtime owner recovery authenticates the retained native document", async ({
	page,
	context,
}) => {
	test.skip(
		process.env.OPENCLAW_PAIRED !== "1",
		"Requires paired hosted boundary and real Traefik",
	);
	test.setTimeout(120_000);
	const entry = process.env.OPENCLAW_TEST_ENTRY;
	if (!entry) throw new Error("Official OpenClaw fixture is missing");
	const deployment = mutationDeploymentReadFixture({
		...includedBasicDeployment,
		openclaw_control_ui_url: endpoint,
		config_info: { ...includedBasicDeployment.config_info, runtime: "openclaw" },
	});
	if (deployment.runtime_ui_endpoint?.runtime !== "openclaw")
		throw new Error("Runtime endpoint missing");
	deployment.runtime_ui_endpoint.browser_session_url = `${endpoint}.well-known/openclaw/browser-session`;
	await stubHostedApi(page, { deployments: [deployment] });
	let initialHandoffs = 0;
	await page.route("**/v2/deployments/*/runtime-ui/credentials", async (route) => {
		const { stdout } = await promisify(execFile)("node", [entry, "dashboard", "--json"], {
			timeout: 20_000,
		});
		const params = new URLSearchParams(new URL(JSON.parse(stdout).browserUrl).hash.slice(1));
		params.set("gatewayUrl", endpoint.replace("https:", "wss:").replace(/\/$/, ""));
		initialHandoffs += 1;
		await route.fulfill({
			json: {
				runtime: "openclaw",
				auth_mode: "openclaw_token",
				url: endpoint,
				deployment_resource_version: deployment.resource.metadata.resourceVersion,
				token: "isolated-test-gateway-secret",
				handoff_url: `${endpoint}#${params}`,
			},
		});
	});
	await context.addCookies([
		{
			name: "native-probe",
			value: "preserved",
			domain: "agent-42-18789.prod.clawdi.test",
			path: "/",
			secure: true,
			httpOnly: true,
			sameSite: "Strict",
		},
	]);
	const connections: Array<{ auth: string[]; hello: string | null; closed: boolean }> = [];
	page.on("websocket", (socket) => {
		if (!socket.url().startsWith(endpoint.replace("https:", "wss:").replace(/\/$/, ""))) return;
		const connection = { auth: [] as string[], hello: null as string | null, closed: false };
		connections.push(connection);
		socket.on("framesent", ({ payload }) => {
			const frame = JSON.parse(String(payload));
			if (frame.method === "connect") connection.auth = Object.keys(frame.params.auth ?? {});
		});
		socket.on("framereceived", ({ payload }) => {
			const frame = JSON.parse(String(payload));
			if (frame.payload?.type === "hello-ok") {
				expect(frame.payload.auth.scopes).toContain("operator.admin");
				connection.hello = frame.payload.server.connId;
			}
		});
		socket.on("close", () => {
			connection.closed = true;
		});
	});
	let documents = 0;
	page.on("request", (request) => {
		if (request.isNavigationRequest() && request.url().startsWith(endpoint)) documents += 1;
	});
	const iframe = page.locator('iframe[title="OpenClaw Control UI"]');
	const transport: Array<{ path: string; method: string; status: number }> = [];
	page.on("response", (response) => {
		if (response.url().startsWith(endpoint))
			transport.push({
				path: new URL(response.url()).pathname,
				method: response.request().method(),
				status: response.status(),
			});
	});
	await page.goto(`/agents/${deployment.agent_id}`);
	try {
		await expect.poll(() => connections[0]?.hello, { timeout: 35_000 }).toBeTruthy();
	} catch (error) {
		console.log(
			JSON.stringify({
				transport,
				documents,
				initialHandoffs,
				frames: await iframe.count(),
				page: (await page.locator("body").innerText()).slice(0, 800),
			}),
		);
		throw error;
	}
	await expect(iframe).toBeHidden();
	expect(
		transport.filter((entry) => entry.method === "POST" && entry.path.endsWith("browser-session")),
	).toHaveLength(1);
	expect(
		transport.filter((entry) => entry.method === "HEAD" && entry.path.endsWith("browser-session")),
	).toHaveLength(1);
	expect(connections[0]?.auth).toEqual(["bootstrapToken"]);
	const grant = (await context.cookies()).find((cookie) => cookie.name === cookieName);
	expect(grant).toMatchObject({
		domain: "agent-42-18789.prod.clawdi.test",
		path: "/.well-known/openclaw/",
		secure: true,
		httpOnly: true,
		sameSite: "Strict",
	});
	const frame = await (await iframe.elementHandle())?.contentFrame();
	if (!frame) throw new Error("Native frame missing");
	await frame.evaluate(() => {
		for (const key of Object.keys(localStorage))
			if (key.startsWith("openclaw.device.auth.v1:")) localStorage.removeItem(key);
	});
	await page.request.post("http://127.0.0.1:19445/fixture/hold");
	const recoveryRequested = page.waitForRequest(
		`${endpoint}.well-known/openclaw/browser-bootstrap`,
	);
	await page.reload();
	await recoveryRequested;
	const recoveringFrame = await (await iframe.elementHandle())?.contentFrame();
	if (!recoveringFrame) throw new Error("Recovering native frame missing");
	const originalDocument = await recoveringFrame.evaluateHandle(() => window.document);
	await page.request.post("http://127.0.0.1:19445/fixture/release");
	await expect.poll(() => connections[2]?.hello, { timeout: 35_000 }).toBeTruthy();
	expect(connections).toHaveLength(3);
	expect(connections[1]?.auth).toEqual([]);
	expect(connections[2]?.auth).toEqual(["bootstrapToken"]);
	expect(initialHandoffs).toBe(1);
	expect(documents).toBe(2);
	const recovered = connections[2];
	await expect(iframe).toBeHidden();
	await page
		.getByTestId("app-sidebar")
		.locator(`a[href="/agents/${deployment.agent_id}/console"]`)
		.click();
	await expect(iframe).toBeVisible();
	expect(connections.at(-1)).toBe(recovered);
	expect(recovered?.closed).toBe(false);
	expect(await originalDocument.evaluate((original) => original === window.document)).toBe(true);
	await originalDocument.dispose();
	expect(documents).toBe(2);
	await page.reload();
	try {
		await expect.poll(() => connections[3]?.hello, { timeout: 35_000 }).toBeTruthy();
	} catch (error) {
		console.log(JSON.stringify({ connections, documents, transport: transport.slice(-8) }));
		throw error;
	}
	expect(connections[3]?.auth).toEqual(["deviceToken"]);
	expect(initialHandoffs).toBe(1);
	const issuer = await (await page.request.get("http://127.0.0.1:19445/fixture")).json();
	expect(issuer.issued).toBe(1);
	// A same-site dashboard request still cannot invoke the same-origin issuer.
	const denied = await page.evaluate(async (url) => {
		try {
			return (await fetch(url, { credentials: "include" })).status;
		} catch {
			return "cors-denied";
		}
	}, `${endpoint}.well-known/openclaw/browser-bootstrap`);
	expect([403, "cors-denied"]).toContain(denied);
	for (const suffix of ["unknown", "browser-bootstrap/", "..%2f..%2f", "%2f..%2f"]) {
		await page.request.get(`${endpoint}.well-known/openclaw/${suffix}`);
	}
	const observation = await (
		await page.request.get("http://127.0.0.1:19446/__native_fixture__")
	).json();
	expect(observation.privateHeaders).toBe(0);
	expect(observation.nativeCookie).toBeGreaterThan(0);
	expect(observation.forwardedNonLoopback).toBeGreaterThan(0);
	// A failed grant at an unchanged resource version remains an explicit retry.
	let rejected = false;
	await page.route(`${endpoint}.well-known/openclaw/browser-session`, async (route) => {
		if (!rejected && route.request().method() === "POST") {
			rejected = true;
			await route.fulfill({
				status: 503,
				headers: {
					"Access-Control-Allow-Origin": "https://cloud.clawdi.test:19444",
					"Access-Control-Allow-Credentials": "true",
				},
				body: "",
			});
		} else await route.continue();
	});
	await page.reload();
	await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
	await expect(iframe).toHaveCount(0);
	expect(initialHandoffs).toBe(1);
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect.poll(() => connections[4]?.hello, { timeout: 35_000 }).toBeTruthy();
	expect(initialHandoffs).toBe(2);
	console.log(JSON.stringify({ initialHandoffs, documents, connections, issuer, observation }));
});
