import type { components, DeployComponents } from "@clawdi/shared/api";
import { expect, type Page, test } from "@playwright/test";
import { includedBasicDeployment, stubHostedApi } from "./hosted-stub-api";

const agentId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "hdep_workspace_skills";
const projectId = "project-hosted";
const listPath = `/agents/${agentId}/project-access/${projectId}/skills`;
const apiPath = `http://127.0.0.1:8001/v2/deployments/${deploymentId}/workspace-skills`;
type ManagedSkillList = components["schemas"]["AgentSkillDesiredListResponse"];
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
	await page.route(`http://127.0.0.1:8000/v1/agents/${agentId}/skills`, (route) =>
		route.fulfill({ json: { agent_id: agentId, skills: [], removal_failures: [] } }),
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
	await dialog.getByRole("tab", { name: "GitHub", exact: true }).click();
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
	await expect(page.getByRole("button", { name: "Install skill", exact: true })).toBeEnabled();
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
	await dialog.getByRole("tab", { name: "GitHub", exact: true }).click();
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

test("Library Skills use references from both entry points, show source content, and uninstall", async ({
	page,
}) => {
	await workspace(page);
	const libraryProjectId = "project-library";
	const skillId = "22222222-2222-4222-8222-222222222222";
	const project: components["schemas"]["ProjectResponse"] = {
		id: libraryProjectId,
		name: "Team Skills",
		slug: "team-skills",
		kind: "workspace",
		description: null,
		origin_environment_id: null,
		archived_at: null,
		created_at: "2026-07-15T00:00:00Z",
		is_owner: true,
		skill_count: 1,
		vault_count: 0,
		agent_count: 0,
		member_count: 1,
	};
	const sourceSkill = {
		id: skillId,
		skill_key: "team/review-pr",
		name: "review-pr",
		description: "Team review instructions",
		authority: "cloud",
		project_id: libraryProjectId,
		project_kind: "workspace",
		source: "cloud",
		version: 2,
		file_count: 1,
		content_hash: "b".repeat(64),
		created_at: project.created_at,
		updated_at: project.created_at,
		content: "# Team review\nUse the team checklist.",
	};
	let installed = false;
	let installs = 0;
	let detailReads = 0;
	const canonical = (): ManagedSkillList => ({
		agent_id: agentId,
		removal_failures: [],
		skills: installed
			? [
					{
						skill_key: "review-pr",
						name: "review-pr",
						description: "Team review instructions",
						source: "library",
						authority: "cloud",
						read_only: false,
						skill_id: skillId,
						project_id: libraryProjectId,
						source_skill_key: sourceSkill.skill_key,
						content_hash: sourceSkill.content_hash,
						source_identity: "c".repeat(64),
						desired_state: "present",
						convergence: "not_observed",
					},
				]
			: [],
	});
	await page.route(apiPath, (route) => route.fulfill({ json: inventory() }));
	await page.route("http://127.0.0.1:8000/v1/projects", (route) =>
		route.fulfill({ json: [project] }),
	);
	await page.route("http://127.0.0.1:8000/v1/skills?**", (route) => {
		const library =
			new URL(route.request().url()).searchParams.get("project_id") === libraryProjectId;
		return route.fulfill({
			json: {
				items: library ? [sourceSkill] : [],
				total: library ? 1 : 0,
				page: 1,
				page_size: 200,
			},
		});
	});
	await page.route(`http://127.0.0.1:8000/v1/agents/${agentId}/skills`, (route) =>
		route.fulfill({ json: canonical() }),
	);
	await page.route(
		`http://127.0.0.1:8000/v1/agents/${agentId}/skill-references/${skillId}`,
		(route) => {
			if (route.request().method() === "GET") {
				detailReads += 1;
				return route.fulfill({
					json: { ...sourceSkill, content: detailReads === 1 ? null : sourceSkill.content },
				});
			}
			installed = route.request().method() === "PUT";
			if (installed) installs += 1;
			return route.fulfill({
				status: 202,
				json: {
					agent_id: agentId,
					skill_id: skillId,
					desired_state: installed ? "present" : "absent",
				},
			});
		},
	);
	await page.goto(listPath);
	await page.getByRole("button", { name: "Install skill", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByRole("combobox", { name: "Library Project" }).click();
	await page.getByRole("option", { name: /Team Skills/ }).click();
	await dialog.getByRole("combobox", { name: "Library Skill" }).click();
	await page.getByRole("option", { name: "review-pr", exact: true }).click();
	await dialog.getByRole("button", { name: "Install skill", exact: true }).click();
	await expect(dialog).toBeHidden();
	await page.getByRole("link", { name: /review-pr/ }).click();
	await expect(page.getByText("Skill instructions aren't available right now.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Copy skill" })).toBeDisabled();
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Team review", exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "View in Library" })).toHaveAttribute(
		"href",
		/project=project-library/,
	);
	await page.getByRole("link", { name: "Skills", exact: true }).last().click();
	await page.getByRole("button", { name: "Uninstall review-pr from Agent" }).click();
	await page
		.getByRole("alertdialog")
		.getByRole("button", { name: "Uninstall skill", exact: true })
		.click();
	await expect(page.getByRole("link", { name: /review-pr/ })).toHaveCount(0);

	await page.route("http://127.0.0.1:8000/v1/agents", (route) =>
		route.fulfill({
			json: [
				{
					id: agentId,
					name: "Reviewer",
					default_name: "Reviewer",
					display_name: null,
					machine_name: "hosted.local",
					agent_type: "hermes",
					default_project_id: projectId,
				},
			],
		}),
	);
	await page.goto(`/skills?project=${libraryProjectId}`);
	await page.getByRole("button", { name: "Install review-pr on an Agent" }).click();
	await dialog.getByRole("combobox", { name: "Target Agent" }).click();
	await page.getByRole("option", { name: /Reviewer/ }).click();
	await dialog.getByRole("button", { name: "Install skill", exact: true }).click();
	await expect(dialog).toBeHidden();
	expect(installs).toBe(2);
});
