import { expect, type Page, type Route, test } from "@playwright/test";

const now = "2026-08-05T12:00:00.000Z";
const projectId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";

const agent = {
	id: agentId,
	name: "review-agent",
	default_name: "Review Agent",
	display_name: "Review Agent",
	machine_name: "review-agent.local",
	agent_type: "openclaw",
	agent_version: "1.0.0",
	os: "linux",
	last_seen_at: now,
	last_sync_at: now,
	last_sync_error: null,
	last_revision_seen: 1,
	queue_depth_high_water: 0,
	dropped_count: 0,
	sync_enabled: true,
	explicit_identity: true,
	default_project_id: workspaceId,
};

async function fulfill(route: Route, body: unknown) {
	await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function expectNoHorizontalOverflow(page: Page) {
	await expect
		.poll(() =>
			page.evaluate(() => ({
				viewport: window.innerWidth,
				content: document.documentElement.scrollWidth,
			})),
		)
		.toEqual(
			expect.objectContaining({ viewport: expect.any(Number), content: expect.any(Number) }),
		);
	const widths = await page.evaluate(() => ({
		viewport: window.innerWidth,
		content: document.documentElement.scrollWidth,
	}));
	expect(widths.content).toBeLessThanOrEqual(widths.viewport + 1);
}

test("Project detail uses explicit local pages and whole-bundle Link at mobile and desktop", async ({
	page,
}) => {
	let project = {
		id: projectId,
		name: "Client Review",
		slug: "client-review",
		kind: "workspace",
		description: "Review instructions and credentials together." as string | null,
		origin_environment_id: null,
		archived_at: null,
		created_at: now,
		is_owner: true,
		owner_display: "Dev User",
		owner_handle: "dev-user",
		skill_count: 2,
		vault_count: 1,
		agent_count: 1,
		member_count: 0,
	};
	const projectResourceRequests: string[] = [];
	const boundedAgentRequests: string[] = [];
	const linkedBodies: unknown[] = [];
	const updateBodies: unknown[] = [];

	await page.addInitScript(() => localStorage.setItem("clawdi-theme", "dark"));
	await page.setViewportSize({ width: 390, height: 844 });
	await page.route("**/v1/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		if (path === `/v1/projects/${projectId}`) {
			if (request.method() === "PATCH") {
				const body = request.postDataJSON() as { name: string; description: string | null };
				updateBodies.push(body);
				project = { ...project, ...body };
			}
			return fulfill(route, project);
		}
		if (path === "/v1/projects") return fulfill(route, [project]);
		if (path === "/v1/agents") {
			if (url.searchParams.get("project_id") === projectId)
				boundedAgentRequests.push(request.url());
			return fulfill(route, [agent]);
		}
		if (path === `/v1/agents/${agentId}/project-bindings`) {
			return fulfill(route, [
				{
					id: "44444444-4444-4444-8444-444444444444",
					agent_id: agentId,
					project_id: workspaceId,
					binding_type: "primary",
					priority: 0,
					default_write_enabled: true,
					created_at: now,
				},
			]);
		}
		if (path === `/v1/agents/${agentId}/project-bindings/context`) {
			linkedBodies.push(request.postDataJSON());
			return fulfill(route, {
				id: "55555555-5555-4555-8555-555555555555",
				agent_id: agentId,
				project_id: projectId,
				binding_type: "context",
				priority: 1,
				default_write_enabled: false,
				created_at: now,
			});
		}
		if (path === "/v1/skills") {
			projectResourceRequests.push(request.url());
			return fulfill(route, { items: [], total: 0, page: 1, page_size: 200 });
		}
		if (path === "/v1/vault") {
			projectResourceRequests.push(request.url());
			return fulfill(route, { items: [], total: 0, page: 1, page_size: 200 });
		}
		if (path === `/v1/projects/${projectId}/members`) return fulfill(route, []);
		if (path === "/v1/dashboard/stats") return fulfill(route, {});
		if (path === "/v1/auth/keys") return fulfill(route, []);
		return fulfill(route, {});
	});

	await page.goto(`/projects/${projectId}`);
	await expect(page.getByRole("heading", { name: "Client Review" })).toBeVisible({
		timeout: 15_000,
	});
	const projectNav = page.getByRole("navigation", { name: "Project pages" });
	await expect(projectNav.getByRole("link")).toHaveCount(5);
	await expect(projectNav.getByRole("link", { name: "Overview" })).toHaveAttribute(
		"aria-current",
		"page",
	);
	expect(projectResourceRequests).toEqual([]);
	await expect(page.locator("html")).toHaveClass(/dark/);
	await expectNoHorizontalOverflow(page);

	await projectNav.getByRole("link", { name: "Skills" }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=skills$`));
	await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
	await expect
		.poll(() => projectResourceRequests.some((request) => request.includes("/v1/skills")))
		.toBe(true);
	await expectNoHorizontalOverflow(page);

	await page
		.getByRole("navigation", { name: "Project pages" })
		.getByRole("link", { name: "Agents" })
		.click();
	await expect(page.getByText("Review Agent", { exact: true })).toBeVisible();
	await expect.poll(() => boundedAgentRequests.length).toBe(1);

	await page.setViewportSize({ width: 1280, height: 900 });
	await expectNoHorizontalOverflow(page);
	await page.getByRole("button", { name: "Link Project" }).click();
	const linkDialog = page.getByRole("dialog", { name: "Link Project to Agent" });
	await expect(linkDialog).toContainText("Skills and attached Vaults as one bundle");
	await linkDialog.getByRole("button", { name: "Link Project" }).click();
	await expect.poll(() => linkedBodies).toEqual([{ project_id: projectId }]);

	await page
		.getByRole("navigation", { name: "Project pages" })
		.getByRole("link", { name: "Access" })
		.click();
	await page.getByRole("button", { name: "Edit Project" }).click();
	const editDialog = page.getByRole("dialog", { name: "Edit Project" });
	await editDialog.getByLabel("Name").fill("Client Review Updated");
	await editDialog.getByLabel("Description").fill("Updated Project purpose.");
	await editDialog.getByRole("button", { name: "Save changes" }).click();
	await expect
		.poll(() => updateBodies)
		.toEqual([{ name: "Client Review Updated", description: "Updated Project purpose." }]);
	await expect(page.getByRole("heading", { name: "Client Review Updated" })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test("legacy Skill detail stays view-only until the URL names a Project", async ({ page }) => {
	const project = {
		id: projectId,
		name: "Client Review",
		slug: "client-review",
		kind: "workspace",
		description: null,
		origin_environment_id: null,
		archived_at: null,
		created_at: now,
		is_owner: true,
		owner_display: "Dev User",
		owner_handle: "dev-user",
		skill_count: 1,
		vault_count: 0,
		agent_count: 0,
		member_count: 0,
	};
	const skill = {
		id: "44444444-4444-4444-8444-444444444444",
		skill_key: "review-pr",
		name: "Review PR",
		description: "Review changes carefully.",
		version: 1,
		source: "cloud",
		authority: "cloud",
		source_repo: null,
		file_count: 1,
		content: "---\nname: Review PR\n---\nReview changes carefully.\n",
		agent_types: ["openclaw"],
		created_at: now,
		content_hash: "a".repeat(64),
		updated_at: now,
		project_id: projectId,
		project_name: project.name,
		project_kind: project.kind,
		environment_id: null,
		machine_name: null,
	};
	const detailRequests: string[] = [];
	const mutationRequests: string[] = [];

	await page.route("**/v1/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() !== "GET") mutationRequests.push(request.url());
		if (url.pathname === "/v1/projects") return fulfill(route, [project]);
		if (url.pathname === "/v1/agents") return fulfill(route, []);
		if (
			url.pathname === "/v1/skills/review-pr" ||
			url.pathname === `/v1/projects/${projectId}/skills/review-pr`
		) {
			detailRequests.push(url.pathname);
			return fulfill(route, skill);
		}
		if (url.pathname === "/v1/dashboard/stats") return fulfill(route, {});
		if (url.pathname === "/v1/auth/keys") return fulfill(route, []);
		return fulfill(route, {});
	});

	await page.goto("/skills/review-pr");
	await expect(page.getByRole("heading", { name: "Review PR" })).toBeVisible({ timeout: 15_000 });
	await expect(page.getByText("Choose a Project to make changes", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Remove from Project" })).toHaveCount(0);
	expect(detailRequests).toEqual(["/v1/skills/review-pr"]);
	expect(mutationRequests).toEqual([]);

	await page.goto(`/skills/review-pr?project=${projectId}`);
	await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Remove from Project" })).toBeVisible();
	await expect(page.getByText("Choose a Project to make changes", { exact: true })).toHaveCount(0);
	expect(detailRequests).toEqual([
		"/v1/skills/review-pr",
		`/v1/projects/${projectId}/skills/review-pr`,
	]);
	expect(mutationRequests).toEqual([]);
});
