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
		config_info: { ...includedBasicDeployment.config_info, runtime: "openclaw" },
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
	}> = [];
	page.on("websocket", (socket) => {
		if (!socket.url().startsWith("wss://127.0.0.1:19443")) return;
		const connection = {
			connects: [] as string[][],
			hello: null as string | null,
			device: null as string | null,
			closed: false,
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
});
