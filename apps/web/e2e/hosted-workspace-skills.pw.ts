import type { components, DeployComponents } from "@clawdi/shared/api";
import { expect, type Page, test } from "@playwright/test";
import { includedBasicDeployment, stubHostedApi } from "./hosted-stub-api";

const agentId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "hdep_workspace_skills";
const projectId = "project-hosted";
const listPath = `/agents/${agentId}/project-access/${projectId}/skills`;
const apiPath = `http://127.0.0.1:8001/v2/deployments/${deploymentId}/workspace-skills`;
type SkillList = DeployComponents["schemas"]["V2WorkspaceSkillListResponse"];
const source: DeployComponents["schemas"]["V2WorkspaceSkillSource"] = {
	type: "github",
	url: "https://github.com/example/skills",
	path: "review-pr",
	commit: "a".repeat(40),
};

async function workspace(page: Page) {
	await stubHostedApi(page, {
		deployments: [
			{
				...includedBasicDeployment,
				id: deploymentId,
				agent_id: agentId,
				config_info: {
					...includedBasicDeployment.config_info,
					clawdi_cloud_environments: { hermes: agentId },
				},
			},
		],
	});
	const project: components["schemas"]["ProjectResponse"] = {
		id: projectId,
		name: "Hosted Workspace",
		slug: "hosted-workspace",
		kind: "environment",
		description: null,
		origin_environment_id: agentId,
		archived_at: null,
		created_at: "2026-07-15T00:00:00Z",
		is_owner: true,
		skill_count: 0,
		vault_count: 0,
		agent_count: 1,
		member_count: 1,
	};
	await page.route(`http://127.0.0.1:8000/v1/agents/${agentId}/project-bindings`, (route) =>
		route.fulfill({
			json: [
				{
					id: "binding-workspace",
					agent_id: agentId,
					project_id: projectId,
					binding_type: "primary",
					priority: 0,
					default_write_enabled: true,
					created_at: project.created_at,
				},
			],
		}),
	);
	await page.route("http://127.0.0.1:8000/v1/projects", (route) =>
		route.fulfill({ json: [project] }),
	);
	await page.route(`http://127.0.0.1:8000/v1/projects/${projectId}`, (route) =>
		route.fulfill({ json: project }),
	);
	await page.route("http://127.0.0.1:8000/v1/skills?**", (route) =>
		route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 200 } }),
	);
}

function inventory(
	items: SkillList["items"] = [],
	capability: SkillList["capability"] = { available: true, reason: "available" },
): SkillList {
	return {
		deployment_id: deploymentId,
		deployment_resource_version: "rv-skills",
		manifest_generation: 1,
		capability,
		items,
	};
}

test("Hosted Skills install, open pinned content, and uninstall without a Cloud projection", async ({
	page,
}) => {
	await workspace(page);
	let items: SkillList["items"] = [];
	await page.route(apiPath, async (route) => {
		if (route.request().method() === "POST") {
			expect(route.request().postDataJSON()).toEqual({ repo: "example/skills", path: "review-pr" });
			expect(route.request().headers()["idempotency-key"]).toBeTruthy();
			expect(route.request().headers()["if-match"]).toBeTruthy();
			items = [{ skill_key: "review-pr", source, status: "requested" }];
			return route.fulfill({
				json: {
					...inventory(),
					skill_key: "review-pr",
					source,
					desired_state: "present",
					status: "requested",
				},
			});
		}
		return route.fulfill({ json: inventory(items) });
	});
	await page.route(`${apiPath}/review-pr`, (route) => {
		if (route.request().method() === "DELETE") {
			items = [];
			return route.fulfill({
				json: {
					...inventory(),
					skill_key: "review-pr",
					desired_state: "absent",
					status: "requested",
				},
			});
		}
		return route.fulfill({
			json: {
				skill_key: "review-pr",
				name: "review-pr",
				description: "Review pull requests",
				source,
				content:
					"---\nname: review-pr\ndescription: Review pull requests\n---\n# Review instructions\nRead the diff before reviewing.",
			},
		});
	});
	await page.goto(listPath);
	await page.getByRole("button", { name: "Install skill", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("GitHub Skill repository").fill("example/skills/review-pr");
	await dialog.getByRole("button", { name: "Install skill", exact: true }).click();
	await expect(dialog).toBeHidden();
	await page.getByRole("link", { name: /review-pr/ }).click();
	await expect(page.getByRole("heading", { name: "Review instructions" })).toBeVisible();
	await expect(page.getByRole("link", { name: "View source on GitHub" })).toHaveAttribute(
		"href",
		`${source.url}/tree/${source.commit}/review-pr`,
	);
	await expect(page.getByRole("button", { name: "Copy skill" })).toBeVisible();
	await page.getByRole("link", { name: "Skills", exact: true }).last().click();
	await page.getByRole("button", { name: "Uninstall review-pr from Agent" }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Uninstall skill", exact: true })
		.click();
	await expect(page.getByText("No Skills are available in this Agent's Workspace.")).toBeVisible();
});

test("Hosted Skills explain unavailable installation and retain discovered Skill details", async ({
	page,
}) => {
	await workspace(page);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.route(apiPath, (route) =>
		route.fulfill({ json: inventory([], { available: false, reason: "upgrade_not_observed" }) }),
	);
	await page.route("http://127.0.0.1:8000/v1/skills?**", (route) =>
		route.fulfill({
			json: {
				items: [
					{
						id: "synced",
						skill_key: "local-guide",
						name: "Local Guide",
						description: "An Agent-owned guide",
						authority: "agent_sync",
						project_id: projectId,
						version: 1,
					},
				],
				total: 1,
				page: 1,
				page_size: 200,
			},
		}),
	);
	await page.goto(listPath);
	await expect(page.getByRole("button", { name: "Install skill", exact: true })).toBeDisabled();
	await expect(
		page.getByText("Installation will be available when your Agent is ready."),
	).toBeVisible();
	await expect(page.getByRole("link", { name: /Local Guide/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /Uninstall Local Guide/ })).toHaveCount(0);
});

test("Hosted Skills keep errors actionable and allow retry without losing the form", async ({
	page,
}) => {
	await workspace(page);
	let attempts = 0;
	let items: SkillList["items"] = [];
	await page.route(apiPath, (route) => {
		if (route.request().method() !== "POST") return route.fulfill({ json: inventory(items) });
		attempts += 1;
		if (attempts === 1)
			return route.fulfill({
				status: 400,
				json: {
					detail: { code: "workspace_skill_source_invalid", message: "Invalid GitHub Skill" },
				},
			});
		const status = attempts === 2 ? "failed" : "requested";
		items = [{ skill_key: "review-pr", source, status }];
		return route.fulfill({
			json: { ...inventory(), skill_key: "review-pr", source, desired_state: "present", status },
		});
	});
	await page.goto(listPath);
	await page.getByRole("button", { name: "Install skill", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("GitHub Skill repository").fill("example/skills/review-pr");
	await dialog.getByRole("button", { name: "Install skill", exact: true }).click();
	await expect(
		dialog.getByText(
			"Couldn't find a valid Skill at this GitHub path. Check the repository and try again.",
		),
	).toBeVisible();
	await expect(dialog.getByLabel("GitHub Skill repository")).toHaveValue(
		"example/skills/review-pr",
	);
	await dialog.getByRole("button", { name: "Install skill", exact: true }).click();
	await expect(dialog.getByText("Update failed. We'll retry automatically.")).toBeVisible();
	await dialog.getByRole("button", { name: "Install skill", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("link", { name: /review-pr/ })).toBeVisible();
	await expect(page.getByText("Couldn't update Skills", { exact: true })).toHaveCount(0);
});
