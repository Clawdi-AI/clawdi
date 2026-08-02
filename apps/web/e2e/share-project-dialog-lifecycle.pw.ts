import { expect, type Page, type Route, test } from "@playwright/test";

const now = "2026-08-02T12:00:00.000Z";
const project = {
	id: "project-sharing",
	name: "Shared workspace",
	slug: "shared-workspace",
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

async function stubSharingApi(page: Page) {
	let links = [
		{
			id: "link-one",
			prefix: "link-prefix",
			label: "Review link",
			created_at: now,
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

	await page.route("**/v1/**", async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === "/v1/projects") return json(route, [project]);
		if (path === "/v1/agents") return json(route, []);
		if (path === "/v1/dashboard/stats") return json(route, {});
		if (path === "/v1/skills") return json(route, { items: [], total: 0, page: 1, page_size: 25 });
		if (path === "/v1/projects/project-sharing/share-links") return json(route, links);
		if (path === "/v1/projects/project-sharing/invitations") return json(route, invitations);
		if (path === "/v1/projects/project-sharing/members") return json(route, members);
		if (request.method() === "DELETE" && path.endsWith("/share-links/link-one")) {
			links = [];
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

test("sharing row mutations retain targets through Base UI exit and reopen cleanly", async ({
	page,
}) => {
	await stubSharingApi(page);
	await page.setViewportSize({ width: 320, height: 720 });
	await page.goto("/projects");
	await page.getByRole("button", { name: "Share Shared workspace" }).click();

	const cases = [
		{
			trigger: "Turn off share link link-prefix",
			action: "Turn Off Link",
			retained: "Turn off this share link?",
		},
		{
			trigger: "Cancel invitation for invitee@example.com",
			action: "Cancel invitation",
			retained: "invitee@example.com",
		},
		{
			trigger: "Remove member member@example.com",
			action: "Remove Member",
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
	await page.getByRole("button", { name: "Share Shared workspace" }).click();
	await expect(
		page.getByRole("button", { name: /Turn off share link|Cancel invitation|Remove / }),
	).toHaveCount(0);
});
