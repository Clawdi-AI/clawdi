import { expect, test } from "@playwright/test";

function stubResponse(path: string): unknown {
	if (["/v1/agents", "/v1/projects", "/v1/connectors", "/v1/vault"].includes(path)) return [];
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
	test(`Add agent hands off to Clawdi Desktop with manual fallbacks at ${width}px`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height: 1000 });
		await page.route("**/v1/**", (route) =>
			route.fulfill({ json: stubResponse(new URL(route.request().url()).pathname) }),
		);
		await page.goto("/");
		await page.getByRole("button", { name: "Connect your own agent" }).click();

		const dialog = page.getByRole("dialog", { name: "Add an agent" });
		await expect(dialog.getByRole("button", { name: "Open Clawdi Desktop" })).toHaveAttribute(
			"href",
			"clawdi-desktop://connect",
		);
		const download = dialog.getByRole("link", { name: "Download Clawdi Desktop" });
		await expect(download).toHaveAttribute("href", /^https:\/\/github\.com\/Clawdi-AI\/clawdi\//);
		await expect(download).toHaveAttribute("target", "_blank");
		await expect(dialog.getByRole("tab", { name: "Run commands" })).toBeVisible();
		await expect(dialog.getByRole("tab", { name: "Ask your agent" })).toBeVisible();
		await expect(dialog.getByText("Waiting for your agent to connect…")).toBeVisible();
	});
}
