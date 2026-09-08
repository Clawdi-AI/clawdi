import type { components } from "@clawdi/shared/api";
import { expect, type Page, type Route, test } from "@playwright/test";

const now = "2026-08-02T12:00:00.000Z";
const project = {
	id: "project-sharing",
	name: "Team Knowledge",
	slug: "team-knowledge",
	kind: "workspace",
	origin_environment_id: null,
	archived_at: null,
	created_at: now,
	is_owner: true,
	owner_display: "Dev User",
	owner_handle: "dev-user",
};

async function json(route: Route, body: unknown, status = 200) {
	await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function stubSharingApi(page: Page, empty = false) {
	let links: components["schemas"]["ShareLinkResponse"][] = [
		{
			id: "link-one",
			prefix: "link-prefix",
			label: "Review link",
			created_at: now,
			expires_at: null,
			revoked_at: null,
			redeem_count: 0,
			last_redeemed_at: null,
		},
	];
	let invitations = [{ id: "invite-one", invitee_email: "invitee@example.com", created_at: now }];
	let members = [
		{
			id: "member-one",
			user_id: "user-one",
			user_email: "member@example.com",
			user_display: "Member One",
			role: "viewer",
			joined_via: "invitation",
			joined_at: now,
		},
	];

	links.push({
		id: "old-link",
		label: "Old invite link",
		prefix: "old-prefix",
		created_at: now,
		expires_at: null,
		revoked_at: now,
		redeem_count: 0,
		last_redeemed_at: null,
	});
	links.push({
		id: "expired-link",
		label: "Expired invite link",
		prefix: "expired-prefix",
		created_at: now,
		expires_at: now,
		revoked_at: null,
		redeem_count: 0,
		last_redeemed_at: null,
	});
	if (empty) {
		links = [];
		invitations = [];
		members = [];
	}

	await page.route("**/v1/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/v1/projects") return json(route, [project]);
		if (path === "/v1/agents") return json(route, []);
		if (path === "/v1/dashboard/stats") return json(route, {});
		if (path === "/v1/skills") return json(route, { items: [], total: 0, page: 1, page_size: 25 });
		if (path === "/v1/projects/project-sharing/share-links") {
			if (request.method() === "POST") {
				expect(request.postDataJSON()).toEqual({});
				const link = {
					id: "created-link",
					prefix: "new-prefix",
					label: null,
					created_at: now,
					expires_at: null,
				};
				links.push({ ...link, revoked_at: null, redeem_count: 0, last_redeemed_at: null });
				return json(route, {
					...link,
					raw_token: "test-token",
					url: "https://example.com/share/test-token",
					owner_handle: "dev-user",
				});
			}
			return json(route, links);
		}
		if (path === "/v1/projects/project-sharing/invitations") {
			if (request.method() === "POST") {
				const invitation = {
					id: "new-invite",
					invitee_email: request.postDataJSON().email,
					created_at: now,
				};
				invitations.push(invitation);
				return json(route, invitation);
			}
			return json(route, invitations);
		}
		if (path === "/v1/projects/project-sharing/members") return json(route, members);
		if (path === "/v1/projects/project-sharing/unshare" && request.method() === "POST") {
			links = links.map((link) => ({ ...link, revoked_at: now }));
			invitations = [];
			members = [];
			return json(route, {
				links_revoked: links.length,
				members_removed: 1,
				invitations_cancelled: 1,
				agent_bindings_removed: 0,
			});
		}
		if (request.method() === "DELETE" && path.endsWith("/share-links/link-one")) {
			links = links.map((link) => (link.id === "link-one" ? { ...link, revoked_at: now } : link));
			return json(route, {});
		}
		if (request.method() === "DELETE" && path.endsWith("/invitations/invite-one")) {
			invitations = [];
			return json(route, {});
		}
		if (request.method() === "DELETE" && path.endsWith("/members/user-one")) {
			members = [];
			return json(route, {});
		}
		return json(route, {});
	});
}

async function openSharing(page: Page) {
	await page.goto("/projects");
	await page.getByRole("button", { name: "Actions for Team Knowledge" }).click();
	await page.getByRole("menuitem", { name: "Share", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
}

test("sharing row mutations retain targets through Base UI exit and reopen cleanly", async ({
	page,
}) => {
	await stubSharingApi(page);
	await page.setViewportSize({ width: 320, height: 720 });
	await openSharing(page);

	const cases = [
		{
			trigger: "Turn off invite link link-prefix",
			action: "Turn off link",
			retained: "Turn off this invite link?",
		},
		{
			trigger: "Cancel invitation for invitee@example.com",
			action: "Cancel invitation",
			retained: "invitee@example.com",
		},
		{
			trigger: "Remove member member@example.com",
			action: "Remove member",
			retained: "member@example.com",
		},
	] as const;

	for (const item of cases) {
		const trigger = page.getByRole("button", { name: item.trigger });
		await trigger.click();
		const alert = page.getByRole("alertdialog");
		await expect(alert).toContainText(item.retained);
		await alert.getByRole("button", { name: item.action }).click();
		await expect(alert).toHaveAttribute("data-ending-style", "");
		await expect(alert).toContainText(item.retained);
		await expect(alert).toBeHidden();
		await expect(trigger).toHaveCount(0);
	}

	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();
	await page.getByRole("button", { name: "Actions for Team Knowledge" }).click();
	await page.getByRole("menuitem", { name: "Share", exact: true }).click();
	await expect(
		page.getByRole("button", { name: /Turn off invite link|Cancel invitation|Remove / }),
	).toHaveCount(0);
});

for (const viewport of [
	{ width: 1280, height: 900 },
	{ width: 320, height: 720 },
]) {
	test(`compact sharing flow at ${viewport.width}px`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await stubSharingApi(page, true);
		await openSharing(page);
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText("Only you have access", { exact: true })).toBeVisible();
		await expect(
			dialog.getByRole("button", { name: "Stop all sharing for this Project" }),
		).toBeHidden();
		await expect(
			dialog.getByText(/People can view this Project and let their Agents use its keys/),
		).toHaveCount(1);
		const dimensions = await dialog.evaluate((element) => ({
			width: element.clientWidth,
			scrollWidth: element.scrollWidth,
			height: element.clientHeight,
			scrollHeight: element.scrollHeight,
		}));
		expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
		expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height);

		await dialog.getByRole("textbox", { name: "Invitee email" }).fill("new-person@example.com");
		await dialog.getByRole("button", { name: "Invite email to project" }).click();
		await expect(dialog.getByText("new-person@example.com", { exact: true })).toBeVisible();
		await expect(dialog.getByText("Pending", { exact: true })).toBeVisible();
		await dialog.getByRole("button", { name: "Create invite link" }).click();
		await expect(dialog.getByRole("textbox", { name: "New invite link URL" })).toHaveValue(
			"https://example.com/share/test-token",
		);
		await expect(dialog.getByRole("button", { name: /Copy agent handoff prompt/ })).toBeHidden();
		await dialog.getByText("Send to an Agent", { exact: true }).click();
		await expect(dialog.getByRole("button", { name: /Copy agent handoff prompt/ })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await page.getByRole("button", { name: "Actions for Team Knowledge" }).click();
		await page.getByRole("menuitem", { name: "Share", exact: true }).click();
		await expect(dialog.getByRole("textbox", { name: "New invite link URL" })).toHaveCount(0);
	});
}

test("sharing management stays disclosed and failed actions remain retryable", async ({ page }) => {
	await stubSharingApi(page);
	await openSharing(page);
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText("member@example.com", { exact: true })).toBeVisible();
	await expect(dialog.getByText("Old invite link", { exact: true })).toBeHidden();
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect(dialog.getByText("Expired invite link", { exact: true })).toBeHidden();
	await dialog.getByText("Inactive links (2)", { exact: true }).click();
	await expect(dialog.getByText("Expired", { exact: true })).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Turn off invite link expired-prefix" }),
	).toHaveCount(0);
	await expect(dialog.getByText("Old invite link", { exact: true })).toBeVisible();
	await page.route("**/v1/projects/project-sharing/share-links", async (route) => {
		if (route.request().method() === "POST") return json(route, { detail: "Internal error" }, 500);
		await route.fallback();
	});
	await dialog.getByRole("button", { name: "Create invite link" }).click();
	await expect(page.getByText("Couldn't create link. Try again.", { exact: true })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Create invite link" })).toBeEnabled();
	await dialog.getByText("Manage sharing", { exact: true }).click();
	await dialog.getByRole("button", { name: "Stop all sharing for this Project" }).press("Enter");
	const confirmation = page.getByRole("alertdialog");
	await confirmation.getByRole("button", { name: "Keep sharing" }).click();
	await expect(confirmation).toBeHidden();
	await expect(dialog.getByText("member@example.com", { exact: true })).toBeVisible();
	await dialog.getByRole("button", { name: "Stop all sharing for this Project" }).press("Enter");
	await page.route(
		"**/v1/projects/project-sharing/unshare",
		(route) => json(route, { detail: "Internal error" }, 500),
		{ times: 1 },
	);
	await confirmation.getByRole("button", { name: "Stop all sharing", exact: true }).click();
	await expect(page.getByText("Couldn't stop sharing", { exact: true })).toBeVisible();
	await expect(confirmation).toBeVisible();
	await confirmation.getByRole("button", { name: "Stop all sharing", exact: true }).click();
	await expect(confirmation).toBeHidden();
	await expect(dialog.getByText("Only you have access", { exact: true })).toBeVisible();
	await expect(dialog.getByText("invitee@example.com", { exact: true })).toHaveCount(0);
	await expect(dialog.getByRole("button", { name: /Turn off invite link/ })).toHaveCount(0);
});

test("a newly created URL survives failed refresh and clipboard access", async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: async () => {
					throw new DOMException("Clipboard denied", "NotAllowedError");
				},
			},
		});
	});
	await stubSharingApi(page);
	await openSharing(page);
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByText("Review link", { exact: true })).toBeVisible();
	await page.route("**/v1/projects/project-sharing/share-links", async (route) => {
		if (route.request().method() === "GET") return json(route, { detail: "Internal error" }, 500);
		await route.fallback();
	});
	const failedRefresh = page.waitForResponse(
		(response) =>
			response.request().method() === "GET" &&
			response.url().endsWith("/share-links") &&
			response.status() === 500,
	);
	await dialog.getByRole("button", { name: "Create invite link" }).click();
	await failedRefresh;
	const url = dialog.getByRole("textbox", { name: "New invite link URL" });
	await expect(url).toHaveValue("https://example.com/share/test-token");
	await dialog.getByRole("button", { name: "Copy invite link", exact: true }).click();
	await expect(
		page.getByText("Select the text and copy it manually.", { exact: true }),
	).toBeVisible();
	await expect(url).toBeVisible();
	await dialog.getByRole("button", { name: "Done", exact: true }).click();
	await expect(url).toHaveCount(0);
});
