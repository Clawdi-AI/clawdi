import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
	includedBasicDeployment,
	mutationDeploymentReadFixture,
	stubHostedApi,
} from "./hosted-stub-api";

const entry = process.env.OPENCLAW_TEST_ENTRY;
const endpoint = "https://127.0.0.1:19443/";

test("official OpenClaw authenticates before reveal and reuses native auth across agent visits", async ({
	page,
}) => {
	test.skip(!entry, "Requires the isolated official OpenClaw gateway fixture");
	test.setTimeout(120_000);
	if (!entry) throw new Error("Missing official gateway entry");
	const deployment = mutationDeploymentReadFixture({
		...includedBasicDeployment,
		openclaw_control_ui_url: endpoint,
		config_info: {
			...includedBasicDeployment.config_info,
			runtime: "openclaw",
		},
	});
	const otherAgent = mutationDeploymentReadFixture({
		...includedBasicDeployment,
		id: "hdep_other_agent",
		name: "Another agent",
		status: "stopped",
	});
	await stubHostedApi(page, { deployments: [deployment, otherAgent] });
	let issued = 0;
	await page.route("**/v2/deployments/*/runtime-ui/credentials", async (route) => {
		const { stdout } = await promisify(execFile)("node", [entry, "dashboard", "--json"], {
			timeout: 20_000,
		});
		const native = JSON.parse(stdout);
		const url = new URL(native.browserUrl);
		const fragment = new URLSearchParams(url.hash.slice(1));
		expect(fragment.has("bootstrapToken")).toBe(true);
		// The isolated TLS ingress publishes the same gateway at a different origin.
		fragment.set("gatewayUrl", endpoint.replace("https:", "wss:").replace(/\/$/, ""));
		issued += 1;
		await route.fulfill({
			json: {
				runtime: "openclaw",
				auth_mode: "openclaw_token",
				url: endpoint,
				deployment_resource_version: deployment.resource.metadata.resourceVersion,
				token: "isolated-test-gateway-secret",
				handoff_url: `${endpoint}#${fragment}`,
			},
		});
	});
	const connections: Array<{
		connects: string[][];
		hello: string | null;
		device: string | null;
		closed: boolean;
		errors: string[];
	}> = [];
	page.on("websocket", (socket) => {
		if (!socket.url().startsWith("wss://127.0.0.1:19443")) return;
		const connection = {
			connects: [] as string[][],
			hello: null as string | null,
			device: null as string | null,
			closed: false,
			errors: [] as string[],
		};
		connections.push(connection);
		socket.on("framesent", ({ payload }) => {
			const frame = JSON.parse(String(payload));
			if (frame.method === "connect") {
				connection.connects.push(Object.keys(frame.params.auth ?? {}));
				connection.device = frame.params.device?.id ?? null;
			}
		});
		socket.on("framereceived", ({ payload }) => {
			const frame = JSON.parse(String(payload));
			if (frame.error?.details?.code) connection.errors.push(frame.error.details.code);
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
	const navigate = async (section: string) => {
		await page
			.getByTestId("app-sidebar")
			.locator(`a[href="/agents/${deployment.agent_id}${section}"]`)
			.click();
		await expect(page).toHaveURL(`/agents/${deployment.agent_id}${section}`);
	};
	await page.goto(`/agents/${deployment.agent_id}`);
	// The official CLI may take up to 20s; wait for issuance before judging the iframe.
	await expect.poll(() => issued, { timeout: 25_000 }).toBe(1);
	await expect(iframe).toHaveCount(1);
	await expect(iframe).toBeHidden();
	await expect.poll(() => connections[0]?.hello, { timeout: 30_000 }).toBeTruthy();
	const initial = connections[0];
	expect(initial?.connects).toEqual([["bootstrapToken"]]);
	const document = await (await iframe.elementHandle())?.contentFrame();
	if (!document) throw new Error("Official UI frame is missing");
	const originalDocument = await document.evaluateHandle(() => window.document);
	for (const section of ["/console", "", "/settings", "/console"]) {
		await navigate(section);
		if (section === "/console") {
			await expect(iframe).toBeVisible();
			await expect(document.locator("openclaw-app-shell")).toBeVisible();
		}
		expect(await originalDocument.evaluate((original) => original === window.document)).toBe(true);
		expect(connections).toHaveLength(1);
		expect(initial?.closed).toBe(false);
		expect(initial?.connects).toHaveLength(1);
		expect(issued).toBe(1);
		expect(documents).toBe(1);
	}
	await originalDocument.dispose();
	// Leaving the agent retires its document. Returning must use native device auth,
	// not mint a bootstrap token or replay the single-use handoff.
	await page.getByRole("button", { name: "Another agent", exact: true }).click();
	await expect(page).toHaveURL(`/agents/${otherAgent.agent_id}`);
	await expect(iframe).toHaveCount(0);
	await page.goBack();
	await expect.poll(() => connections[1]?.hello).toBeTruthy();
	expect(connections[1]?.connects).toEqual([["deviceToken"]]);
	expect(connections[1]?.device).toBe(initial?.device);
	expect(issued).toBe(1);
	await page.reload();
	await expect.poll(() => connections[2]?.hello).toBeTruthy();
	expect(connections[2]?.connects).toEqual([["deviceToken"]]);
	expect(connections[2]?.device).toBe(initial?.device);
	expect(issued).toBe(1);
	await page.getByRole("button", { name: "Reconnect", exact: true }).click();
	await expect.poll(() => connections[3]?.hello).toBeTruthy();
	expect(connections[3]?.connects).toEqual([["bootstrapToken"]]);
	expect(connections[3]?.device).toBe(initial?.device);
	expect(issued).toBe(2);
	console.log(JSON.stringify({ issued, documents, connections }));
	// A Clawdi load hint survives independently of the official device credential.
	// Remove only the isolated browser's token, preserving its device identity.
	const currentDocument = await (await iframe.elementHandle())?.contentFrame();
	if (!currentDocument) throw new Error("Official UI frame is missing");
	const removed = await currentDocument.evaluate(() => {
		const keys = Object.keys(localStorage).filter((key) =>
			key.startsWith("openclaw.device.auth.v1:"),
		);
		for (const key of keys) localStorage.removeItem(key);
		return keys.length;
	});
	expect(removed).toBeGreaterThan(0);
	const recovery = page.waitForResponse(
		(response) => response.url() === `${endpoint}.well-known/openclaw/browser-bootstrap`,
	);
	await page.goto(`/agents/${otherAgent.agent_id}`);
	await page.goto(`/agents/${deployment.agent_id}`);
	await expect(iframe).toBeHidden();
	expect((await recovery).status()).toBe(404);
	expect(connections[4]?.hello).toBeNull();
	expect(connections[4]?.errors).toContain("AUTH_TOKEN_MISSING");
	expect(issued).toBe(2);
	console.log("Missing device credential", JSON.stringify(connections[4]));
	// A test-only issuer isolates the official UI's recovery contract. This is not
	// a production authentication boundary: the paired hosted implementation must
	// authorize a runtime-origin owner grant before it may issue this response.
	let recoveries = 0;
	let releaseRecovery = () => {};
	const recoveryAllowed = new Promise<void>((resolve) => {
		releaseRecovery = resolve;
	});
	await page.route(`${endpoint}.well-known/openclaw/browser-bootstrap`, async (route) => {
		await recoveryAllowed;
		const { stdout } = await promisify(execFile)("node", [entry, "dashboard", "--json"], {
			timeout: 20_000,
		});
		const params = new URLSearchParams(new URL(JSON.parse(stdout).browserUrl).hash.slice(1));
		recoveries += 1;
		await route.fulfill({
			json: {
				bootstrapToken: params.get("bootstrapToken"),
				bootstrapProfile: "owner",
			},
			headers: { "Cache-Control": "no-store" },
		});
	});
	const recoveryRequested = page.waitForRequest(
		`${endpoint}.well-known/openclaw/browser-bootstrap`,
	);
	await page.reload();
	await recoveryRequested;
	const recoveringDocument = await (await iframe.elementHandle())?.contentFrame();
	if (!recoveringDocument) throw new Error("Recovering UI frame is missing");
	const retainedDocument = await recoveringDocument.evaluateHandle(() => window.document);
	releaseRecovery();
	await expect
		.poll(() => connections.findLast((connection) => connection.hello), {
			timeout: 30_000,
		})
		.not.toBe(connections[3]);
	const recovered = connections.at(-1);
	expect(recovered?.hello).toBeTruthy();
	expect(recovered?.connects).toEqual([["bootstrapToken"]]);
	expect(recovered?.device).toBe(initial?.device);
	expect(recoveries).toBe(1);
	await navigate("/console");
	expect(await retainedDocument.evaluate((original) => original === window.document)).toBe(true);
	await retainedDocument.dispose();
	expect(connections.at(-1)).toBe(recovered);
	expect(recovered?.closed).toBe(false);
	if (!recovered?.device) throw new Error("Recovered device identity is missing");
	await promisify(execFile)(
		"node",
		[entry, "devices", "revoke", "--device", recovered.device, "--role", "operator", "--json"],
		{ timeout: 20_000 },
	);
	const revokedIndex = connections.length;
	await page.goto(`/agents/${deployment.agent_id}`);
	await expect.poll(() => connections[revokedIndex]?.errors.length).toBeGreaterThan(0);
	await expect.poll(() => connections[revokedIndex]?.closed).toBe(true);
	expect(connections[revokedIndex]?.errors).toEqual(["AUTH_DEVICE_TOKEN_MISMATCH"]);
	expect(connections[revokedIndex]?.hello).toBeNull();
	expect(recoveries).toBe(1);
	console.log("Revoked device credential", JSON.stringify(connections.slice(revokedIndex)), {
		recoveries,
	});
});

for (const failure of ["expired", "consumed"] as const) {
	test(`official OpenClaw characterizes ${failure} bootstrap recovery`, async ({
		page,
		browser,
	}) => {
		test.skip(!entry, "Requires the isolated official OpenClaw gateway fixture");
		test.setTimeout(90_000);
		if (!entry) throw new Error("Missing official gateway entry");
		// Backdate only the isolated issuing CLI process. The browser and gateway
		// retain real time, so expiration is checked by the real gateway.
		const clock = "data:text/javascript,const now=Date.now();Date.now=()=>now-660000";
		const { stdout } = await promisify(execFile)(
			"node",
			[...(failure === "expired" ? ["--import", clock] : []), entry, "dashboard", "--json"],
			{ timeout: 20_000 },
		);
		const native = JSON.parse(stdout);
		const fragment = new URLSearchParams(new URL(native.browserUrl).hash.slice(1));
		fragment.set("gatewayUrl", endpoint.replace("https:", "wss:").replace(/\/$/, ""));
		const handoff = `${endpoint}#${fragment}`;
		if (failure === "consumed") {
			const consumer = await browser.newContext({ ignoreHTTPSErrors: true });
			try {
				const consumingPage = await consumer.newPage();
				let consumed = false;
				consumingPage.on("websocket", (socket) =>
					socket.on("framereceived", ({ payload }) => {
						if (JSON.parse(String(payload)).payload?.type === "hello-ok") consumed = true;
					}),
				);
				await consumingPage.goto(handoff);
				await expect.poll(() => consumed, { timeout: 30_000 }).toBe(true);
			} finally {
				await consumer.close();
			}
		}
		const deployment = mutationDeploymentReadFixture({
			...includedBasicDeployment,
			openclaw_control_ui_url: endpoint,
			config_info: {
				...includedBasicDeployment.config_info,
				runtime: "openclaw",
			},
		});
		await stubHostedApi(page, { deployments: [deployment] });
		let issued = 0;
		await page.route("**/v2/deployments/*/runtime-ui/credentials", async (route) => {
			issued += 1;
			await route.fulfill({
				json: {
					runtime: "openclaw",
					auth_mode: "openclaw_token",
					url: endpoint,
					deployment_resource_version: deployment.resource.metadata.resourceVersion,
					token: "isolated-test-gateway-secret",
					handoff_url: handoff,
				},
			});
		});
		const errors: string[] = [];
		let hello = false;
		let closed = false;
		let recoveryRequests = 0;
		page.on("request", (request) => {
			if (request.url().endsWith("/.well-known/openclaw/browser-bootstrap")) recoveryRequests += 1;
		});
		page.on("websocket", (socket) => {
			socket.on("framereceived", ({ payload }) => {
				const frame = JSON.parse(String(payload));
				if (frame.error?.details?.code) errors.push(frame.error.details.code);
				if (frame.payload?.type === "hello-ok") hello = true;
			});
			socket.on("close", () => {
				closed = true;
			});
		});
		await page.goto(`/agents/${deployment.agent_id}`);
		await expect.poll(() => errors.length, { timeout: 30_000 }).toBeGreaterThan(0);
		await expect.poll(() => closed).toBe(true);
		expect(hello).toBe(false);
		expect(recoveryRequests).toBe(0);
		console.log(
			`${failure} bootstrap`,
			JSON.stringify({ errors, hello, recoveryRequests, issued }),
		);
		// The failed document still writes today's load hint; the next visit loses
		// the rejected fragment and reaches the missing-credential recovery route.
		const recovery = page.waitForResponse(
			(response) => response.url() === `${endpoint}.well-known/openclaw/browser-bootstrap`,
		);
		await page.reload();
		expect((await recovery).status()).toBe(404);
		expect(issued).toBe(1);
		expect(hello).toBe(false);
	});
}
