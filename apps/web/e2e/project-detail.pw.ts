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
	const vaultCreateRequests: Array<{ url: URL; body: unknown }> = [];

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
			if (request.method() === "POST") {
				vaultCreateRequests.push({ url, body: request.postDataJSON() });
				return fulfill(route, {
					id: "66666666-6666-4666-8666-666666666666",
					slug: "production-credentials",
				});
			}
			return fulfill(route, { items: [], total: 0, page: 1, page_size: 200 });
		}
		if (path === `/v1/projects/${projectId}/members`) return fulfill(route, []);
		if (path === "/v1/dashboard/stats") return fulfill(route, {});
		if (path === "/v1/auth/keys") return fulfill(route, []);
		return fulfill(route, {});
	});

	await page.goto(`/projects/${projectId}?source=on-clawdi&d=deployment-1&joined=share`);
	await expect(page.getByRole("heading", { name: "Client Review" })).toBeVisible({
		timeout: 15_000,
	});
	const projectTabs = page.getByRole("tablist", { name: "Project pages" });
	await expect(projectTabs.getByRole("tab")).toHaveCount(5);
	const overviewTab = projectTabs.getByRole("tab", { name: "Overview" });
	await expect(overviewTab).toHaveAttribute("aria-selected", "true");
	expect(projectResourceRequests).toEqual([]);
	await expect(page.locator("html")).toHaveClass(/dark/);
	await expectNoHorizontalOverflow(page);

	await overviewTab.focus();
	await page.keyboard.press("ArrowRight");
	await expect(projectTabs.getByRole("tab", { name: "Skills" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(page).toHaveURL((url) => {
		return (
			url.pathname === `/projects/${projectId}` &&
			url.searchParams.get("tab") === "skills" &&
			url.searchParams.get("source") === "on-clawdi" &&
			url.searchParams.get("d") === "deployment-1" &&
			!url.searchParams.has("joined")
		);
	});
	await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
	await expect
		.poll(() => projectResourceRequests.some((request) => request.includes("/v1/skills")))
		.toBe(true);
	await expectNoHorizontalOverflow(page);

	await projectTabs.getByRole("tab", { name: "Vaults" }).click();
	await expect(page.getByRole("heading", { name: "Vaults", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Attach vault", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Create vault", exact: true }).click();
	const createVaultDialog = page.getByRole("dialog", { name: "Create vault" });
	await createVaultDialog.getByLabel("Vault name").fill("Production Credentials");
	await createVaultDialog.getByRole("button", { name: "Create vault" }).click();
	await expect(createVaultDialog).toHaveCount(0);
	await expect.poll(() => vaultCreateRequests).toHaveLength(1);
	expect(vaultCreateRequests[0]?.body).toEqual({
		slug: "production-credentials",
		name: "Production Credentials",
	});
	expect(vaultCreateRequests[0]?.url.searchParams.get("project_id")).toBe(projectId);
	expect(vaultCreateRequests[0]?.url.searchParams.get("create_only")).toBe("true");
	await expect(page).toHaveURL((url) => {
		return (
			url.pathname === `/projects/${projectId}` &&
			url.searchParams.get("tab") === "vaults" &&
			url.searchParams.get("source") === "on-clawdi" &&
			url.searchParams.get("d") === "deployment-1"
		);
	});

	await page
		.getByRole("tablist", { name: "Project pages" })
		.getByRole("tab", { name: "Agents" })
		.click();
	await expect(page.getByText("Review Agent", { exact: true })).toBeVisible();
	await expect.poll(() => boundedAgentRequests.length).toBe(1);

	await page.setViewportSize({ width: 1280, height: 900 });
	await expectNoHorizontalOverflow(page);
	await page.getByRole("button", { name: "Link project" }).click();
	const linkDialog = page.getByRole("dialog", { name: "Link project to Agent" });
	await expect(linkDialog).toContainText("Skills and attached Vaults as one bundle");
	await linkDialog.getByRole("button", { name: "Link project" }).click();
	await expect.poll(() => linkedBodies).toEqual([{ project_id: projectId }]);

	await page
		.getByRole("tablist", { name: "Project pages" })
		.getByRole("tab", { name: "Access" })
		.click();
	await page.getByRole("button", { name: "Edit project" }).click();
	const editDialog = page.getByRole("dialog", { name: "Edit project" });
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
	await expect(page.getByRole("button", { name: "Remove from project" })).toHaveCount(0);
	expect(detailRequests).toEqual(["/v1/skills/review-pr"]);
	expect(mutationRequests).toEqual([]);

	await page.goto(`/skills/review-pr?project=${projectId}`);
	await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Remove from project" })).toBeVisible();
	await expect(page.getByText("Choose a Project to make changes", { exact: true })).toHaveCount(0);
	expect(detailRequests).toEqual([
		"/v1/skills/review-pr",
		`/v1/projects/${projectId}/skills/review-pr`,
	]);
	expect(mutationRequests).toEqual([]);
});

test("Skills library selects one Project before reading or creating Skills", async ({ page }) => {
	const project = {
		id: projectId,
		name: "Client Review",
		slug: "client-review",
		kind: "workspace",
		description: "Review instructions and credentials together.",
		origin_environment_id: null,
		archived_at: null,
		created_at: now,
		is_owner: true,
		owner_display: "Dev User",
		owner_handle: "dev-user",
		skill_count: 0,
		vault_count: 1,
		agent_count: 0,
		member_count: 0,
	};
	const skillRequests: URL[] = [];
	const createBodies: unknown[] = [];

	await page.setViewportSize({ width: 390, height: 844 });
	await page.route("**/v1/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (url.pathname === "/v1/projects") return fulfill(route, [project]);
		if (url.pathname === "/v1/agents") return fulfill(route, []);
		if (url.pathname === "/v1/skills") {
			skillRequests.push(url);
			return fulfill(route, { items: [], total: 0, page: 1, page_size: 24 });
		}
		if (url.pathname === `/v1/projects/${projectId}/skills`) {
			createBodies.push(request.postDataJSON());
			return fulfill(route, {
				skill_key: "review-pull-requests",
				name: "Review pull requests",
				version: 1,
				file_count: 1,
				content_hash: "a".repeat(64),
			});
		}
		if (url.pathname === "/v1/dashboard/stats") return fulfill(route, {});
		if (url.pathname === "/v1/auth/keys") return fulfill(route, []);
		return fulfill(route, {});
	});

	await page.goto("/skills");
	await expect(page.getByRole("heading", { name: "Skills", level: 1 })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByRole("heading", { name: "Choose a Project" })).toBeVisible();
	expect(skillRequests).toEqual([]);
	await expectNoHorizontalOverflow(page);

	await page.getByRole("link", { name: "Open Client Review" }).click();
	await expect(page).toHaveURL(`/skills?project=${projectId}`);
	await expect(page.getByRole("button", { name: "Add skill" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Import from GitHub" })).toBeVisible();
	await expect.poll(() => skillRequests.length).toBe(1);
	for (const request of skillRequests)
		expect(request.searchParams.get("project_id")).toBe(projectId);

	await page.getByRole("button", { name: "Add skill" }).click();
	const dialog = page.getByRole("dialog", { name: "Add skill" });
	await dialog.getByLabel("Name").fill("Review pull requests");
	await dialog.getByLabel("Description").fill("Review code before approval");
	await dialog
		.getByLabel("Instructions")
		.fill("Inspect the diff and report blocking issues first.");
	await dialog.getByRole("button", { name: "Add skill" }).click();
	await expect
		.poll(() => createBodies)
		.toEqual([
			{
				name: "Review pull requests",
				description: "Review code before approval",
				instructions: "Inspect the diff and report blocking issues first.",
			},
		]);
	await expect(dialog).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});
