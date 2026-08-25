import { expect, type Page, type Route, test } from "@playwright/test";
import { includedBasicDeployment, readDeploymentFixture, stubHostedApi } from "./hosted-stub-api";

const DEPLOY_API = "http://127.0.0.1:8001";
const CLOUD_API = "http://127.0.0.1:8000";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((nextResolve) => {
		resolve = nextResolve;
	});
	return { promise, resolve };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function deployment(id: string, status: string) {
	return {
		...includedBasicDeployment,
		id,
		agent_id: AGENT_ID,
		status,
		config_info: {
			...includedBasicDeployment.config_info,
			clawdi_cloud_environments: { openclaw: AGENT_ID },
		},
	};
}

function sseFrame(deploymentId: string, sequence = 1): string {
	const eventType = "deployment.state.changed";
	return [
		`id: e2e-cursor-${sequence}`,
		`event: ${eventType}`,
		`data: ${JSON.stringify({
			event_id: `e2e-event-${sequence}`,
			stream_sequence: sequence,
			deployment_id: deploymentId,
			event_type: eventType,
			operation_name: `operations/e2e-${sequence}`,
		})}`,
		"",
		"",
	].join("\n");
}

async function routeDeploymentEvent(
	page: Page,
	deploymentId: string,
	onRelease: () => void,
	gate: Promise<void>,
) {
	await page.route(`${DEPLOY_API}/v2/deployments/${deploymentId}/events`, async (route) => {
		expect(route.request().headers().authorization).toBe("Bearer dev-bypass");
		expect(route.request().headers()["last-event-id"]).toBe("e2e-cursor-0");
		await gate;
		onRelease();
		await route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			headers: { "Cache-Control": "no-store" },
			body: sseFrame(deploymentId),
		});
	});
}

test("creation and restart status converge within two seconds of deployment events", async ({
	page,
}) => {
	const created = deployment("hdep_event_create", "starting");
	const createGate = deferred();
	await stubHostedApi(page, { deployments: [created] });
	let createEventAt = 0;
	await page.route(`${DEPLOY_API}/v2/events`, async (route) => {
		expect(route.request().headers().authorization).toBe("Bearer dev-bypass");
		await createGate.promise;
		created.status = "running";
		createEventAt = Date.now();
		await route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			body: sseFrame(created.id),
		});
	});

	await page.goto("/agents");
	const createdCard = page.locator(`a[href="/agents/${AGENT_ID}"]`).first();
	await expect(createdCard).toContainText("Starting");
	createGate.resolve();
	await expect(createdCard).toContainText("Running", { timeout: 2_000 });
	const createElapsed = Date.now() - createEventAt;
	console.log(`[deployment-events-e2e] create convergence: ${createElapsed}ms`);
	expect(createElapsed).toBeLessThan(2_000);

	const restarting = deployment("hdep_event_restart", "restarting");
	const restartGate = deferred();
	let restartEventAt = 0;
	await stubHostedApi(page, { deployments: [restarting] });
	await routeDeploymentEvent(
		page,
		restarting.id,
		() => {
			restarting.status = "running";
			restartEventAt = Date.now();
		},
		restartGate.promise,
	);

	await page.goto(`/agents/${AGENT_ID}`);
	await expect(page.getByText("Restarting", { exact: true }).first()).toBeVisible();
	restartGate.resolve();
	await expect(page.getByText("Running", { exact: true }).first()).toBeVisible({ timeout: 2_000 });
	const restartElapsed = Date.now() - restartEventAt;
	console.log(`[deployment-events-e2e] restart convergence: ${restartElapsed}ms`);
	expect(restartElapsed).toBeLessThan(2_000);
});

test("plugin convergence refreshes within two seconds of a deployment event", async ({ page }) => {
	const running = deployment("hdep_event_plugin", "running");
	const eventGate = deferred();
	let installed = false;
	let eventAt = 0;
	await stubHostedApi(page, { deployments: [running] });
	await routeDeploymentEvent(
		page,
		running.id,
		() => {
			installed = true;
			eventAt = Date.now();
		},
		eventGate.promise,
	);
	await page.route(`${CLOUD_API}/v1/plugin-catalog`, (route) =>
		fulfillJson(route, {
			plugins: [
				{
					name: "event-plugin",
					version: "1.0.0",
					display_name: "Event Plugin",
					description: "Event-driven plugin",
					publisher: "Clawdi",
					category: "developer-tools",
					keywords: [],
					languages: ["en"],
					runtimes: ["openclaw"],
					components: { skills: [], mcpServers: {} },
					installable: true,
				},
			],
		}),
	);
	await page.route(`${CLOUD_API}/v1/agents/${AGENT_ID}/agent-plugins`, (route) =>
		fulfillJson(route, {
			plugins: [
				{
					installation_id: "33333333-3333-4333-8333-333333333333",
					agent_id: AGENT_ID,
					plugin_name: "event-plugin",
					version: "1.0.0",
					catalog_revision: "a".repeat(40),
					desired_state: "present",
					convergence: installed ? "installed" : "not_observed",
					observation_error_code: null,
					observed_at: installed ? new Date().toISOString() : null,
					created_at: "2026-08-25T00:00:00Z",
					updated_at: new Date().toISOString(),
				},
			],
		}),
	);

	await page.goto(`/agents/${AGENT_ID}/plugins`);
	await expect(page.getByRole("button", { name: "Installing…", exact: true })).toBeDisabled();
	eventGate.resolve();
	await expect(page.getByRole("button", { name: "Installed", exact: true })).toBeDisabled({
		timeout: 2_000,
	});
	const pluginElapsed = Date.now() - eventAt;
	console.log(`[deployment-events-e2e] plugin convergence: ${pluginElapsed}ms`);
	expect(pluginElapsed).toBeLessThan(2_000);
});

test("a rejected cursor obtains a fresh snapshot before reconnecting", async ({ page }) => {
	const restarting = deployment("hdep_event_cursor", "restarting");
	let handoffRequests = 0;
	const streamCursors: Array<string | undefined> = [];
	let cursorRejectedAt = 0;
	await stubHostedApi(page, { deployments: [restarting] });
	await page.route(`${DEPLOY_API}/v2/deployments**`, async (route) => {
		const url = new URL(route.request().url());
		if (url.searchParams.get("eventStreamHandoff") !== "true") {
			await route.fallback();
			return;
		}
		handoffRequests += 1;
		await fulfillJson(route, {
			snapshot_isolation: "REPEATABLE READ",
			read_only: true,
			deployments: [readDeploymentFixture(restarting)],
			operations: [],
			event_stream_cursor: handoffRequests === 1 ? "rejected-cursor" : "fresh-cursor",
		});
	});
	await page.route(`${DEPLOY_API}/v2/deployments/${restarting.id}/events`, async (route) => {
		const cursor = route.request().headers()["last-event-id"];
		streamCursors.push(cursor);
		if (cursor === "rejected-cursor") {
			cursorRejectedAt = Date.now();
			await fulfillJson(route, { detail: "Cursor signature is no longer valid" }, 403);
			return;
		}
		expect(cursor).toBe("fresh-cursor");
		restarting.status = "running";
		await route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			body: sseFrame(restarting.id),
		});
	});

	await page.goto(`/agents/${AGENT_ID}`);
	await expect(page.getByText("Restarting", { exact: true }).first()).toBeVisible();
	await expect(page.getByText("Running", { exact: true }).first()).toBeVisible({ timeout: 4_000 });
	const elapsed = Date.now() - cursorRejectedAt;
	console.log(`[deployment-events-e2e] rejected cursor recovery: ${elapsed}ms`);
	expect(handoffRequests).toBe(2);
	expect(streamCursors).toEqual(["rejected-cursor", "fresh-cursor"]);
	expect(elapsed).toBeLessThan(3_000);
});

test("deployment polling resumes at the original cadence when the stream is unavailable", async ({
	page,
}) => {
	const restarting = deployment("hdep_event_fallback", "restarting");
	await stubHostedApi(page, { deployments: [restarting] });
	await page.route(`${DEPLOY_API}/v2/events`, (route) =>
		fulfillJson(route, { detail: "stream unavailable" }, 503),
	);

	await page.goto("/agents");
	const card = page.locator(`a[href="/agents/${AGENT_ID}"]`).first();
	await expect(card).toContainText("Restarting");
	const fallbackStartedAt = Date.now();
	restarting.status = "running";
	await expect(card).toContainText("Running", { timeout: 13_000 });
	const elapsed = Date.now() - fallbackStartedAt;
	console.log(`[deployment-events-e2e] disconnected fallback: ${elapsed}ms`);
	expect(elapsed).toBeGreaterThanOrEqual(8_000);
	expect(elapsed).toBeLessThan(13_000);
});
