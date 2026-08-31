import { expect, type Route, test } from "@playwright/test";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SHARE_ID = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-31T10:00:00.000Z";

const session = {
	id: SESSION_ID,
	local_session_id: "share-actions",
	project_path: "/workspace/clawdi",
	agent_name: "Share Codex",
	agent_display_name: "Share Codex",
	agent_default_name: "Codex",
	agent_type: "codex",
	machine_name: "share-machine",
	started_at: now,
	ended_at: null,
	updated_at: now,
	last_activity_at: now,
	duration_seconds: 60,
	message_count: 2,
	input_tokens: 20,
	output_tokens: 30,
	cache_read_tokens: 0,
	model: "gpt-5",
	models_used: ["gpt-5"],
	summary: "Share a response",
	tags: [],
	status: "completed",
	content_hash: null,
	content_protocol: "events-v1",
	event_head_hash: "share-head",
	is_shared: true,
	related_refs: null,
	has_content: true,
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
	await route.fulfill({
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	});
}

test("uses direct message actions and keeps older live links revocable", async ({ page }) => {
	let legacyLinkActive = true;
	let shares: Array<Record<string, unknown>> = [];
	let createdBody: unknown;

	await page.route("**/v1/**", async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/v1/agents") return fulfillJson(route, []);
		if (url.pathname === "/v1/sessions") {
			return fulfillJson(route, {
				items: [],
				total: 0,
				page: 1,
				page_size: 25,
			});
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}`) {
			return fulfillJson(route, session);
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}/messages`) {
			return fulfillJson(route, {
				items: [
					{
						kind: "message",
						position: 1,
						role: "assistant",
						content: "Assistant response ready to share",
						model: "gpt-5",
						timestamp: now,
					},
					{
						kind: "message",
						position: 0,
						role: "user",
						content: "Please share the useful answer",
						model: null,
						timestamp: now,
					},
				],
				total: 2,
				offset: 0,
				limit: 100,
			});
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}/shares`) {
			if (route.request().method() === "GET") return fulfillJson(route, { shares });
			createdBody = route.request().postDataJSON();
			const created = {
				id: SHARE_ID,
				session_id: SESSION_ID,
				scope: "response",
				start_position: 1,
				end_position: 1,
				message_count: 1,
				share_url: `http://127.0.0.1:3200/s/${SHARE_ID}`,
				created_at: now,
			};
			shares = [created];
			return fulfillJson(route, created, 201);
		}
		if (url.pathname === `/v1/sessions/${SESSION_ID}/permissions`) {
			if (route.request().method() === "DELETE") {
				legacyLinkActive = false;
				return route.fulfill({ status: 204 });
			}
			return fulfillJson(route, {
				permissions: legacyLinkActive
					? [
							{
								id: "legacy-link",
								kind: "link",
								role: "viewer",
								created_at: now,
							},
						]
					: [],
			});
		}
		return fulfillJson(route, {});
	});

	await page.goto(`/sessions/${SESSION_ID}`);
	const assistantMessage = page.getByText("Assistant response ready to share", {
		exact: true,
	});
	await expect(assistantMessage).toBeVisible();
	const assistantRow = assistantMessage.locator("xpath=ancestor::div[contains(@class,'group')][1]");
	const actions = assistantRow.getByRole("toolbar", {
		name: "Message actions",
	});
	await expect(actions).toHaveCSS("opacity", "0");
	await assistantRow.hover();
	await expect(actions).toHaveCSS("opacity", "1");
	await expect(actions.getByRole("button", { name: "Copy message" })).toBeVisible();
	await expect(actions.getByRole("button", { name: "Share response" })).toBeVisible();
	await expect(actions.getByRole("button", { name: "Share conversation to here" })).toBeVisible();

	await actions.getByRole("button", { name: "Share response" }).click();
	const responseDialog = page.getByRole("dialog", {
		name: "Share this response",
	});
	await expect(responseDialog).toBeVisible();
	await responseDialog.getByRole("button", { name: "Create link" }).click();
	await expect.poll(() => createdBody).toEqual({ scope: "response", position: 1 });
	await expect(responseDialog.getByLabel("Session share URL")).toHaveValue(
		`http://127.0.0.1:3200/s/${SHARE_ID}`,
	);
	await responseDialog.getByRole("button", { name: "Close" }).click();

	await page.getByRole("button", { name: "Share", exact: true }).click();
	const sessionDialog = page.getByRole("dialog", { name: "Share session" });
	await expect(sessionDialog.getByText("Older link")).toBeVisible();
	const legacyRow = sessionDialog
		.getByText("Live Session link", { exact: true })
		.locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
	await expect(legacyRow).toContainText("Reflects future uploads");
	await legacyRow.getByRole("button", { name: "Turn off share link" }).click();
	const confirmation = page.getByRole("alertdialog", {
		name: "Turn off this share link?",
	});
	await confirmation.getByRole("button", { name: "Turn off link" }).click();
	await expect(sessionDialog.getByText("Live Session link", { exact: true })).not.toBeVisible();
});
