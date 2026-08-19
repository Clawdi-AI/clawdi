import { expect, type Route, test } from "@playwright/test";

const now = "2026-08-18T12:00:00Z";
const projectId = "11111111-1111-4111-8111-111111111111";
const linkedAgentId = "22222222-2222-4222-8222-222222222222";
const buildAgentId = "33333333-3333-4333-8333-333333333333";
const deployAgentId = "44444444-4444-4444-8444-444444444444";

function agent(id: string, displayName: string) {
	return {
		id,
		name: displayName.toLowerCase().replaceAll(" ", "-"),
		default_name: displayName,
		display_name: displayName,
		machine_name: `${displayName.toLowerCase().replaceAll(" ", "-")}.local`,
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
		default_project_id: `${id.slice(0, -1)}9`,
	};
}

async function fulfill(route: Route, body: unknown) {
	await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test("Project link dialog adds multiple Agents without replacing existing links", async ({
	page,
}) => {
	const linkedAgent = agent(linkedAgentId, "Review Agent");
	const buildAgent = agent(buildAgentId, "Build Agent");
	const deployAgent = agent(deployAgentId, "Deploy Agent");
	let availableAgentsLinked = false;
	const linkBodies: unknown[] = [];
	let projectDetailReads = 0;
	let filteredAgentReads = 0;
	const project = () => ({
		id: projectId,
		name: "Client Review",
		slug: "client-review",
		kind: "workspace",
		description: "Shared review resources.",
		origin_environment_id: null,
		archived_at: null,
		created_at: now,
		is_owner: true,
		owner_display: "Dev User",
		owner_handle: "dev-user",
		skill_count: 0,
		vault_count: 0,
		agent_count: availableAgentsLinked ? 3 : 1,
		member_count: 0,
	});

	await page.route("**/v1/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const path = url.pathname;
		if (path === `/v1/projects/${projectId}/agents` && request.method() === "POST") {
			linkBodies.push(request.postDataJSON());
			availableAgentsLinked = true;
			return fulfill(route, {
				project_id: projectId,
				bound_agent_ids: [buildAgentId, deployAgentId],
			});
		}
		if (path === `/v1/projects/${projectId}`) {
			projectDetailReads += 1;
			return fulfill(route, project());
		}
		if (path === "/v1/projects") return fulfill(route, [project()]);
		if (path === "/v1/agents") {
			if (url.searchParams.get("project_id") === projectId) {
				filteredAgentReads += 1;
				return fulfill(
					route,
					availableAgentsLinked ? [linkedAgent, buildAgent, deployAgent] : [linkedAgent],
				);
			}
			return fulfill(route, [linkedAgent, buildAgent, deployAgent]);
		}
		if (path === `/v1/projects/${projectId}/members`) return fulfill(route, []);
		if (path === "/v1/dashboard/stats") return fulfill(route, {});
		if (path === "/v1/auth/keys") return fulfill(route, []);
		return fulfill(route, {});
	});

	await page.goto(`/projects/${projectId}?tab=agents`);
	await expect(page.getByRole("heading", { name: "Client Review" })).toBeVisible({
		timeout: 15_000,
	});
	const agentsSection = page.locator("#agents");
	await expect(agentsSection.getByText("Review Agent", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Link project" }).click();
	const dialog = page.getByRole("dialog", { name: "Link project to Agents" });
	const linkedCheckbox = dialog.getByRole("checkbox", { name: "Review Agent already linked" });
	await expect(linkedCheckbox).toBeChecked();
	await expect(linkedCheckbox).toBeDisabled();
	await expect(dialog.getByText("Linked", { exact: true })).toBeVisible();

	await dialog.getByRole("checkbox", { name: "Link Build Agent" }).click();
	await dialog.getByRole("checkbox", { name: "Link Deploy Agent" }).click();
	await dialog.getByRole("button", { name: "Link 2 Agents" }).click();

	await expect.poll(() => linkBodies).toEqual([{ agent_ids: [buildAgentId, deployAgentId] }]);
	await expect(dialog).toHaveCount(0);
	await expect(agentsSection.getByText("3", { exact: true })).toBeVisible();
	await expect(agentsSection.getByText("Review Agent", { exact: true })).toBeVisible();
	await expect(agentsSection.getByText("Build Agent", { exact: true })).toBeVisible();
	await expect(agentsSection.getByText("Deploy Agent", { exact: true })).toBeVisible();
	await expect.poll(() => projectDetailReads).toBeGreaterThan(1);
	await expect.poll(() => filteredAgentReads).toBeGreaterThan(1);
});
