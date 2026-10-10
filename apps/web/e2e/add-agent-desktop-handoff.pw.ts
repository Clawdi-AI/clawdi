import { expect, test } from "@playwright/test";
import { desktopBridgeCalls, injectDesktopBridge } from "./support/desktop-bridge";

const existingAgent = {
	id: "22222222-2222-4222-8222-222222222222",
	name: "server-hermes",
	default_name: "Server Hermes",
	machine_name: "server.local",
	display_name: "Server Hermes",
	avatar_url: null,
	sort_order: 0,
	agent_type: "hermes",
	agent_version: "1.0.0",
	os: "linux",
	last_seen_at: "2026-10-08T12:00:00.000Z",
	last_sync_at: null,
	last_sync_error: null,
	last_revision_seen: null,
	queue_depth_high_water: 0,
	dropped_count: 0,
	sync_enabled: false,
	explicit_identity: true,
	default_project_id: null,
};

const newAgent = {
	...existingAgent,
	id: "33333333-3333-4333-8333-333333333333",
	name: "desktop-codex",
	default_name: "Desktop Codex",
	machine_name: "laptop.local",
	display_name: "Desktop Codex",
	agent_type: "codex",
	os: "darwin",
};

function stubResponse(path: string, agents: unknown[]): unknown {
	if (path === "/v1/agents") return agents;
	if (["/v1/projects", "/v1/connectors", "/v1/vault"].includes(path)) return [];
	if (["/v1/sessions", "/v1/skills", "/v1/memories", "/v1/connectors/available"].includes(path))
		return { items: [], total: 0, page: 1, page_size: 25 };
	if (path === "/v1/dashboard/stats")
		return {
			total_sessions: 0,
			total_messages: 0,
			total_tokens: 0,
			active_days: 0,
			current_streak: 0,
			longest_streak: 0,
			peak_hour: null,
			favorite_model: null,
			skills_count: 0,
			memories_count: 0,
			vault_count: 0,
			vault_keys_count: 0,
			connectors_count: 0,
			manual_sessions_last_7_days: 0,
			contribution: [],
		};
	return {};
}

for (const width of [1440, 375]) {
	test(`Add agent opens Clawdi Desktop from a launch tab at ${width}px`, async ({
		context,
		page,
	}) => {
		await page.setViewportSize({ width, height: 1000 });
		let agents: unknown[] = [existingAgent];
		await context.route("**/v1/**", (route) =>
			route.fulfill({ json: stubResponse(new URL(route.request().url()).pathname, agents) }),
		);
		await page.goto("/");
		// "Connect another machine" stays mounted when the new agent appears.
		await page.getByRole("button", { name: "Add agent", exact: true }).click();

		const dialog = page.getByRole("dialog", { name: "Add an agent" });
		const open = dialog.getByRole("button", { name: "Open Clawdi Desktop" });
		await expect(open).toHaveAttribute("href", "/desktop/connect");
		await expect(open).toHaveAttribute("target", "_blank");
		const download = dialog.getByRole("link", { name: "Download Clawdi Desktop" });
		await expect(download).toHaveAttribute("href", /^https:\/\/github\.com\/Clawdi-AI\/clawdi\//);
		await expect(dialog.getByRole("tab", { name: "Run commands" })).toBeVisible();
		await expect(dialog.getByRole("tab", { name: "Ask your agent" })).toBeVisible();
		await expect(dialog.getByText("Waiting for your agent to connect…")).toBeVisible();

		const [launch] = await Promise.all([context.waitForEvent("page"), open.click()]);
		await expect(launch).toHaveURL(/\/desktop\/connect$/);
		await expect(launch.getByRole("heading", { name: "Opening Clawdi Desktop…" })).toBeVisible();
		await expect(launch.getByRole("button", { name: "Open Clawdi Desktop" })).toHaveAttribute(
			"href",
			"clawdi-desktop://connect",
		);
		await expect(launch.getByRole("link", { name: "Download Clawdi Desktop" })).toBeVisible();
		await expect(launch.getByRole("link", { name: "Use the manual setup" })).toBeVisible();

		// The dashboard tab keeps its dialog; its watcher resumes when the user returns.
		agents = [existingAgent, newAgent];
		await page.bringToFront();
		await expect(dialog.getByText("Agent registered")).toBeVisible({ timeout: 15_000 });
		await expect(dialog.getByText("Desktop Codex")).toBeVisible();
	});
}

for (const inDesktop of [false, true]) {
	test(`Every connect entry point ${inDesktop ? "opens Clawdi Desktop's Connect window inside Desktop" : "opens the Add agent dialog in a browser"}`, async ({
		context,
		page,
	}) => {
		if (inDesktop) await injectDesktopBridge(page);
		let agents: unknown[] = [];
		await context.route("**/v1/**", (route) =>
			route.fulfill({ json: stubResponse(new URL(route.request().url()).pathname, agents) }),
		);
		const dialog = page.getByRole("dialog", { name: "Add an agent" });
		const entryPoints = [
			// Overview zero state, then the sidebar's New agent.
			() => page.getByRole("button", { name: "Connect your own agent" }).click(),
			() => page.getByRole("button", { name: "New agent", exact: true }).click(),
		];
		await page.goto("/");
		for (const open of entryPoints) {
			await open();
			if (!inDesktop) {
				await expect(dialog).toBeVisible();
				await page.keyboard.press("Escape");
				await expect(dialog).toBeHidden();
			}
		}
		if (inDesktop) {
			await expect
				.poll(() => desktopBridgeCalls(page))
				.toEqual([["openConnector"], ["openConnector"]]);
			await expect(page.getByRole("dialog")).toHaveCount(0);
		}

		// "Connect another machine" once an agent exists. Reloading resets the recorded calls.
		agents = [existingAgent];
		await page.reload();
		await page.getByRole("button", { name: "Add agent", exact: true }).click();
		if (inDesktop) {
			await expect.poll(() => desktopBridgeCalls(page)).toEqual([["openConnector"]]);
			await expect(page.getByRole("dialog")).toHaveCount(0);
		} else {
			await expect(dialog).toBeVisible();
		}
	});
}
